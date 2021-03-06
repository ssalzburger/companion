/*
 * This file is part of the Companion project
 * Copyright (c) 2018 Bitfocus AS
 * Authors: William Viker <william@bitfocus.io>, Håkon Nessjøen <haakon@bitfocus.io>
 *
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 *
 */

var system;
var debug   = require('debug')('lib/instance');
var shortid = require('shortid');
var fs      = require('fs');

function instance(system) {
	var self = this;

	self.system = system;
	self.active = {};
	self.modules = {};
	self.modules_manufacturer = {};
	self.modules_category = {};
	self.modules_name = {};
	self.package_info = {};
	self.status = {};
	self.store = {
		module: [],
		db: {}
	};

	system.emit('instance', self);

	system.on('instance_get_package_info', function(cb) {
		debug("getting instance_get_package_info");
		cb(self.package_info);
	});

	system.on('instance_save', function(){
		system.emit('db_set', 'instance', self.store.db);
		system.emit('db_save');
	});

	// levels: null = unknown, 0 = ok, 1 = warning, 2 = error
	system.on('instance_status_update', function(instance, level, msg) {
		self.status[instance] = [level, msg];
		system.emit('instance_status', self.status);
		system.emit('instance_status_set', instance, level, msg);
	});

	system.on('instance_status_get', function (instance, cb) {
		cb(self.status[instance]);
	});

	system.on('instance_config_get', function (id, cb) {
		cb(self.store.db[id]);
	});

	system.on('instance_get', function (id, cb) {
		cb(self.active[id]);
	});

	system.on('instance_getall', function (cb) {
		cb(self.store.db, self.active);
	});

	system.on('instance_delete', function (id) {
		self.system.emit('log', 'instance(' + id + ')', 'debug', 'instance deleted');

		if (self.active[id] !== undefined) {
			self.active[id].destroy();
			delete self.active[id];
		}
		delete self.status[id];
		delete self.store.db[id];

		self.system.emit('instance_save');
	});

	system.on('skeleton-power', function(event) {

		if (event == 'resume') {
			self.system.emit('log', 'system(power)', 'debug', 'Resuming');

			for (var id in self.active) {
				self.system.emit('log', 'instance('+self.active[id].label+')', 'debug', 'Bringing back instance from sleep');
				self.activate_module(id);
			}
		}

		else if (event == 'suspend') {
			self.system.emit('log', 'system(power)', 'debug', 'Suspending');

			for (var id in self.active) {

				if (self.active[id] !== undefined) {
					try {
						self.active[id].destroy();
					} catch (e) {
						self.system.emit('log', 'instance('+self.active[id].label+')', 'debug', 'Error suspending instance: ' + e.message);
					}
				}

			}

		}

	});

	system.on('instance_init', function() {

		debug('instance_init', self.store.db);

		var path = require('app-root-path') + '/lib/module';
		var module_folders = fs.readdirSync(path);

		var mod_redirects = {};

		for (var i = 0; i < module_folders.length; ++i) {
			var folder = module_folders[i];

			try {

				var packagefile = fs.readFileSync(path +'/'+ folder + '/package.json');
				var moduleconfig = JSON.parse(packagefile);
				var mod = require(path + '/' + folder + '/' + moduleconfig.main);

				self.store.module.push(moduleconfig);
				self.modules[folder] = mod;
				self.package_info[folder] = moduleconfig;

				// Generate keywords list
				if (moduleconfig.keywords !== undefined) {
					for (var r in moduleconfig.keywords) {
						var kw = moduleconfig.keywords[r];
						if (self.modules_category[kw] === undefined) {
							self.modules_category[kw] = [];
						}
						self.modules_category[kw].push(folder);
					}
				}
				else {
					console.log(folder, "- uh, no keywords?")
					process.exit();
				}

				// Generate manufacturer list
				if (moduleconfig.manufacturer !== undefined) {
					if (self.modules_manufacturer[moduleconfig.manufacturer] === undefined) {
						self.modules_manufacturer[moduleconfig.manufacturer] = [];
					}
					self.modules_manufacturer[moduleconfig.manufacturer].push(folder);
				}
				else {
					console.log(folder, "- uh, no manufacturer?")
					process.exit();
				}

				// Add legacy names to the redirect list
				if (moduleconfig.legacy !== undefined) {
					for (var x in moduleconfig.legacy) {
						var from = moduleconfig.legacy[x];
						mod_redirects[from] = moduleconfig.name;
					}
				}

				// Generate label
				if (moduleconfig.name !== undefined) {
					moduleconfig.label = moduleconfig.manufacturer + " " + moduleconfig.product;
					self.modules_name[folder] = moduleconfig.label;
				}

				// Sanity check
				if (moduleconfig.name != folder) {
					debug('Warning: Module ' + folder + ' identifies itself as ' + moduleconfig.name);
					process.exit();
				}

				debug('loaded module '+folder+'@'+moduleconfig.version + ' by ' + moduleconfig.author);
				system.emit('log', 'loaded', 'info', folder+'@'+moduleconfig.version +": " + moduleconfig.label);

			} catch (e) {

				debug("Error loading module " + folder, e);
				system.emit('log', 'module('+folder+')', 'error', 'Error loading module: '+ e);

			}
		}

		for (var id in self.store.db) {
			(function (id) {
				var config = self.store.db[id];

				if (mod_redirects[config.instance_type] !== undefined) {
					config.instance_type = mod_redirects[config.instance_type];
				}

				if (self.modules[config.instance_type] !== undefined) {

					if (config.enabled === false) {
						debug("Won't load disabled module " + id + " (" + config.instance_type + ")");
						return;
					}

					var mod = self.modules[config.instance_type];

					console.log("LOADING INSTANCE", id, config);

					self.active[id] = new mod(self.system, id, config);
					self.active[id].label = config.label;

					if (typeof self.active[id].upgradeConfig == 'function') {
						self.active[id].upgradeConfig();
					}

					if (typeof self.active[id]._init == 'function') {
						debug("Running _init of " + id);
						self.active[id]._init();
					}
				}

				else {
					debug("Configured instance " + config.instance_type + " could not be loaded, unknown module");
					system.emit('log', 'instance('+config.instance_type+')', 'error', "Configured instance " + config.instance_type + " could not be loaded, unknown module");
				}

			})(id);
		}

	});

	system.emit('db_get', 'instance', function(res) {
		if (res === undefined) {
			self.store.db = {};
		}
		else {
			self.store.db = res;
		}

		// TODO: Implement dependency system
		setTimeout(function () {
			system.emit('instance_init');
		}, 2000);
	})

	system.emit('io_get', function(io) {
		self.io = io;

		system.on('instance_status', function(obj) {
			io.emit('instance_status', obj);
		});

		io.on('connect', function(client) {
			self.connect(client);
		});
	});

	system.on('action_run', function(action, extras) {

		if (self.active[action.instance] !== undefined) {
			self.active[action.instance].action(action, extras);
		}
		else {
			debug("trying to run action on a deleted instance.", action)
		}

	});

	system.on('instance_add', function (module, cb) {
		var mod = self.modules[module];
		var id = shortid.generate();

		self.store.db[id] = {};

		self.system.emit('log', 'instance('+id+')', 'debug', 'instance add ' + module);

		self.store.db[id].instance_type = module;

		var label = self.package_info[module].shortname;
		var i = 1;
		var freename = false;

		while (!freename) {
			freename = true;
			for (var key in self.store.db) {
				if (self.store.db[key].label == label) {
					i++;
					label = self.package_info[module].shortname + i;
					freename = false;
					break;
				}
			}
		}

		self.store.db[id].label = label;
		if (self.active[id] !== undefined) {
			self.active[id].label = self.store.db[id].label;
		}

		self.activate_module(id, mod);

		self.io.emit('instance_add:result', id, self.store.db);
		debug('instance_add', id);
		self.system.emit('instance_save');
		self.system.emit('actions_update')

		if (typeof cb == 'function') {
			cb(id, self.store.db[id]);
		}
	});

	system.on('instance_activate', function (id) {
		self.activate_module(id);
	});

	system.on('instance_config_put', function (id, config) {
		for (var key in config) {
			self.store.db[id][key] = config[key];
		}

		if (self.active[id] !== undefined) {
			self.active[id].label = self.store.db[id].label;
		}

		// TODO: Rename variables in all banks

		self.system.emit('instance_save');
		self.io.emit('instance_db_update', self.store.db);

		if (self.active[id] !== undefined) {
			if (typeof self.active[id].updateConfig == 'function') {
				self.active[id].updateConfig(config);
			}
		}

		self.system.emit('log', 'instance('+id+')', 'debug', 'instance configuration updated');
	});

	system.on('instance_enable', function (id, state) {
		self.system.emit('log', 'instance('+id+')', 'debug', (state ? 'Enable' : 'Disable') + ' instance ' + self.store.db[id].label);
		self.store.db[id].enabled = state;
		self.status[id] = [-1, 'Disabled'];

		if (state === false) {
			if (self.active[id] !== undefined) {
				try {
					self.active[id].destroy();
				} catch (e) {
					self.system.emit('log', 'instance('+id+')', 'debug', 'Error disabling instance: ' + e.message);
				}
				delete self.active[id];
			}
		} else {
			self.activate_module(id);
		}

		self.system.emit('instance_save');
	});

	return self;
}

instance.prototype.activate_module = function(id,modin) {

	var self = this;
	var mod;

	console.log("id",id,"modin",modin);

	if (modin !== undefined) {
		mod = modin;
	}
	else {
		mod = self.modules[self.store.db[id].instance_type];
	}

	try {
		self.active[id] = new mod(self.system, id, self.store.db[id]);

		if (self.active[id]._versionscripts !== undefined && self.active[id]._versionscripts.length > 0) {
			// New instances do not need to be upgraded
			self.store.db[id]._configIdx = self.active[id]._versionscripts.length - 1;
		}

		if (self.active[id].label === undefined) {
			self.active[id].label = self.store.db[id].label;
		}

		if (typeof self.active[id]._init == 'function') {
			self.active[id]._init();
		}

	} catch(e) {
		self.system.emit('log', 'instance('+id+')', 'error', 'module failed');
		debug("INSTANCE ADD EXCEPTION:", e);
	}

};

instance.prototype.connect = function (client) {
	var self = this;

	client.on('instance_get', function() {
		client.emit('instance', self.store, {
			manufacturer: self.modules_manufacturer,
			category: self.modules_category,
			name: self.modules_name
		});
	});

	client.on('instance_edit', function(id) {
		var res = self.active[id].config_fields();

		res.unshift({
			type: 'textinput',
			id: 'label',
			label: 'Label',
			width: 12
		});

		client.emit(
			'instance_edit:result',
			id,
			self.store,
			res,
			self.store.db[id]
		);

		if (self.active[id] !== undefined) {
			self.active[id].label = self.store.db[id].label;
		}

		self.system.emit('instance_save');

	});

	client.on('instance_config_put', function (id, config) {

		for (var inst in self.store.db) {
			if (inst != id && self.store.db[inst].label == config.label) {
				client.emit('instance_config_put:result', 'duplicate label');
				return;
			}
		}

		self.system.emit('instance_config_put', id, config);

		client.emit('instance_config_put:result', null, 'ok');
	});

	client.on('instance_status_get', function() {
		client.emit('instance_status', self.status);
	});

	client.on('instance_enable', function(id,state) {
		self.system.emit('instance_enable', id, state);

		client.emit('instance_status', self.status);
		client.emit('instance', self.store, {
			manufacturer: self.modules_manufacturer,
			category: self.modules_category,
			name: self.modules_name
		});

	});

	client.on('instance_delete', function(id) {
		self.system.emit('instance_delete', id, self.active[id] !== undefined ? self.active[id].label : undefined);
	});

	client.on('instance_add', function(module) {
		self.system.emit('instance_add', module);
	});

};

exports = module.exports = function (system) {
	return new instance(system);
};
