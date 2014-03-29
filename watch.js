var _ioClient = require('./sails.io')(require('socket.io-client'));
var path = require('path');
var fs = require('fs');
var glob = require('glob');
var async = require('async');
var log = require('./logger');
var buildDictionary = require('sails-build-dictionary');
var _ = require('lodash');
module.exports = function(sails) {

	var socket;

	return {
		start: function(config, options, cb) {

			// Get the Shipyard URL
			var src = config.src;

			// Get the socket.io client connection
			socket = _ioClient.connect(config.src.baseURL);

			cb = cb || function(){};
			log.verbose("Yarr WATCH started.");

			// When Sails lowers, stop watching
			sails.on('lower', stop);

			options = options || {};
			options.noOrmReload = true;

			// Handle initial socket connection to Sails
			socket.on('connect', function() {

				// Subscribe to updates
				socket.get(config.src.baseURL + '/project/subscribe/'+config.src.projectId+'?secret='+config.src.secret);

				// Load all models from Shipyard, but don't reload ORM (since Sails hasn't started yet)
				reloadAllModels(config, options, function(err) {
					if (err) {return cb(err);}
					// Handle model pubsub messages from Sails
					socket.on('model', handleModelMessage);
					socket.on('project', handleProjectMessage);
					return cb();
				});
					
			});

		}

	};

	/**
	 * Wipe out all model .json files
	 * @param  {Function} cb      [description]
	 * @param  {[type]}   options [description]
	 * @return {[type]}           [description]
	 */
	function clean(cb) {

		glob(path.join(process.cwd(), 'api/models/*.attributes.json'), function(err, files) {
			async.forEach(files, fs.unlink, cb);
		});

	}

	function stop() {
		sails.log.verbose("Yarr WATCH stopped.");
	}



	function handleModelMessage(message) {

		// Handle model updates
		if (message.verb == 'updated') {

			reloadAllModels();
		}

	}

	function handleProjectMessage(message) {

		// Handle model updates
		if (message.verb == 'messaged' && message.data.message == 'model_updated') {

			writeModels(message.data.models);

		}

	}

	function reloadAllModels(config, options, cb) {

		cb = cb || function(){};
		options = options || {};
		config = config || sails.config.shipyard;
		options.config = config;
		
		// Get all the current models for the linked project,
		// and subscribe to changes to those models
		async.auto({
			models: function(cb) {
				if (!options.forceSync) {
					socket.get(config.src.url + '/models?secret='+config.src.secret, function(models) {
						return cb(null, models);
					});
				} else {
					buildDictionary.optional({
						dirname		: path.resolve(process.cwd(),'api/models'),
						filter		: /(.+)\.attributes.json$/,
						replaceExpr : /^.*\//,
						useGlobalIdForKeyName: true,
						flattenDirectories: true
					}, function(err, models) {
						return cb(null, models);
					});
				}
			},
			clean: function(cb) {
				if (options.forceSync) {
					return cb();
				}
				clean(cb);
			},
			write: ['models', 'clean', function(cb, results) {
				writeModels(results.models, options, cb);
			}]
		},

			function(err) {
				if (options.noOrmReload) {
					return cb(err);
				} else {
					reloadOrm(cb);
				}
			}
		);

	}

	function writeModels(models, options, cb) {

		cb = cb || new Function();
		options = options || {};
		var config = options.config || sails.config.shipyard;

		// Load all current Sails user models (/api/models/*.js files)
		buildDictionary.optional({
			dirname		: path.resolve(process.cwd(), 'api/models'),
			filter		: /^([^.]+)\.(js|coffee)$/,
			replaceExpr : /^.*\//,
			flattenDirectories: true,
			useGlobalIdForKeyName: true
		}, function(err, userModels) {

			// Keep an array of any new models we encounter, so we can add them to Shipyard
			var newModels = options.forceSync ? _.values(models) : [];

			// Loop through through the user models
			Object.keys(userModels).forEach(function(userModelGlobalId) {

				// If we already know about this one in Shipyard, just merge our Shipyard version with the user version
				if (models[userModelGlobalId]) {
					models[userModelGlobalId] = {attributes: _.merge(userModels[userModelGlobalId], models[userModelGlobalId]).attributes};
				}
				// Otherwise push it to the newModels array, and add an entry into the "models" hash to make it look like it came from
				// Shipyard, so that we write a .json file for it
				else {
					models[userModelGlobalId] = {attributes: userModels[userModelGlobalId].attributes || {}};
					models[userModelGlobalId].identity = userModelGlobalId.toLowerCase();
					newModels.push({globalId: userModelGlobalId, attributes: userModels[userModelGlobalId].attributes});
				}

			});

			async.auto({
				
				// Upload any new models to Shipyard
				uploadNewModels: function(cb) {
					if (!newModels.length) {return cb();}

					socket.post(config.src.baseURL + '/'+config.src.projectId+'/modules/models/?secret='+config.src.secret, newModels, function(data) {

						if (data.status && data.status != 200) {
							return cb(data);
						}

						// Otherwise we're okay
						return cb();

					});
				},

				// Load the list of top-level controller files
				controllers: function(cb) {
					fs.readdir(path.resolve(process.cwd(), 'api/controllers'), function(err, files) {
						if (err) {return cb(err);}
						cb(null, files.map(function(file) {return file.toLowerCase();}));
					});
				},

				writeToDisk: ['controllers', function(cb, results) {

					// Loop through each of the models we got from Shipyard (or created in response to finding a new user model)
					async.forEach(Object.keys(models), function(globalId, cb) {
						// Make JSON out of model def
						var identity = models[globalId].identity || globalId.toLowerCase();
						var model = {attributes: models[globalId].attributes, globalId: globalId, identity: identity};
						var json = JSON.stringify(model);

						// Write the model's attributes to a JSON file
						fs.writeFile(path.join(process.cwd(), 'api/models/', globalId+'.attributes.json'), json, function(err) {

							if (err) {throw new Error(err);}

							// See if a controller exists for this model
							if (results.controllers.indexOf(identity+'controller.js') !== -1) {
								// If so, we can return now
								return cb();
							}
							// Otherwise create one so we can use blueprints
							fs.writeFile(path.join(process.cwd(), 'api/controllers/', globalId+'Controller.js'), "module.exports = {};", function(err) {
								if (err) {throw new Error(err);}
								cb();
							});

						});

					}, cb);

				}]

			}, cb);

		});

	}

	function reloadOrm(cb) {

		// Reload controller middleware
		sails.hooks.controllers.loadAndRegisterControllers(function() {

			sails.once('hook:orm:reloaded', function() {

				// Flush router
				sails.router.flush();
				// Reload blueprints
				sails.hooks.blueprints.bindShadowRoutes();

				return cb();

			});

			// Reload ORM
			sails.emit('hook:orm:reload');

		});

	}

};