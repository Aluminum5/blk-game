#!/usr/bin/env node
/**
 * Copyright 2012 Google, Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Load compiled code
global.require = require;
var compiledLibrary = require('blk_node_js_compiled');
for (var key in compiledLibrary) {
  global[key] = compiledLibrary[key]
}

// Start the server
var uri = ('file://' + process.argv[1]).replace(/\\/g, '/');
var args = process.argv.slice(2);
blk.server.start(uri, args);
