var path = require('path');
var fs = require('fs-extra');
var glob = require('glob');
var async = require('async');
var log = require('../logger');
var _ = require('lodash');
var beautify = require('js-beautify').js_beautify;

module.exports = function(sails, socket) {

  return {

    createResponse: function (config, options, cb) {

      var self = this;
      cb = cb || function(){};
      options = options || {};
      config = config || sails.config.treelineCli;
      options.config = config;

      async.auto({
        response: function(cb) {
          var response = fs.readFileSync(path.resolve(__dirname, "response.js"));

          // Write the model's attributes to a JSON file
          fs.outputFile(path.join(process.cwd(), (options.export ? '' :  'node_modules/treeline/'), '/api/responses/response.js'), response, cb);
        },
        negotiate: function(cb) {
          var negotiate = fs.readFileSync(path.resolve(__dirname, "negotiate.js"));

          // Write the model's attributes to a JSON file
          fs.outputFile(path.join(process.cwd(), (options.export ? '' :  'node_modules/treeline/'), '/api/responses/negotiate.js'), negotiate, cb);
        }
      }, cb);

    }

  };

};
