/**
 * Copyright 2012 Google Inc. All Rights Reserved.
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

/**
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('blk.game.client.ClientController');

goog.require('blk.assets.audio.BlockSounds');
goog.require('blk.env');
goog.require('blk.env.client.ClientMap');
goog.require('blk.io.ChunkSerializer');
goog.require('blk.net.packets.ChunkData');
goog.require('blk.net.packets.ReadyPlayer');
goog.require('blk.sim.Player');
goog.require('blk.sim.commands');
goog.require('blk.sim.entities');
goog.require('blk.ui.Console');
goog.require('blk.ui.screens.StatusScreen');
goog.require('gf.input.Data');
goog.require('gf.log');
goog.require('gf.net.DisconnectReason');
goog.require('gf.net.INetworkService');
goog.require('gf.net.SessionState');
goog.require('gf.net.chat.ClientChatService');
goog.require('gf.sim.ClientSimulator');
goog.require('gf.sim.IEntityWatcher');
goog.require('gf.vec.Viewport');
goog.require('goog.Disposable');
goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.async.Deferred');



/**
 * Abstract client game controller.
 * @constructor
 * @extends {goog.Disposable}
 * @implements {gf.net.INetworkService}
 * @implements {gf.sim.IEntityWatcher}
 * @param {!blk.game.client.ClientGame} game Client game.
 * @param {!gf.net.ClientSession} session Network session.
 */
blk.game.client.ClientController = function(game, session) {
  goog.base(this);

  // Reset runtime clock
  game.clock = session.clock;

  /**
   * Client game this instance is controlling.
   * @protected
   * @type {!blk.game.client.ClientGame}
   */
  this.game = game;

  /**
   * Network session.
   * @type {!gf.net.ClientSession}
   */
  this.session = session;
  this.session.registerService(this);
  this.setupSwitch(session.packetSwitch);

  /**
   * Chat client.
   * @private
   * @type {!gf.net.chat.ClientChatService}
   */
  this.chatService_ = new gf.net.chat.ClientChatService(this.session);
  this.session.registerService(this.chatService_);

  /**
   * Game map.
   * @private
   * @type {!blk.env.client.ClientMap}
   */
  this.map_ = new blk.env.client.ClientMap();
  this.registerDisposable(this.map_);

  /**
   * Client-side simulation.
   * @private
   * @type {!gf.sim.ClientSimulator}
   */
  this.simulator_ = new gf.sim.ClientSimulator(game, this.session);
  this.registerDisposable(this.simulator_);
  blk.sim.commands.registerCommands(this.simulator_);
  blk.sim.entities.registerEntities(this.simulator_);
  this.simulator_.addWatcher(this);

  /**
   * Input data storage.
   * @private
   * @type {!gf.input.Data}
   */
  this.inputData_ = new gf.input.Data(this.game.getInputManager());

  /**
   * Screen-aligned ortho viewport.
   * @private
   * @type {!gf.vec.Viewport}
   */
  this.screenViewport_ = new gf.vec.Viewport();

  /**
   * UI widgets.
   * @private
   * @type {!Array.<!blk.ui.Widget>}
   */
  this.widgets_ = [];

  /**
   * Console.
   * @private
   * @type {!blk.ui.Console}
   */
  this.console_ = new blk.ui.Console(this.game, this.chatService_);
  this.registerDisposable(this.console_);
  //this.addWidget(this.console_);

  // TODO(benvanik): move this someplace else - feels wrong here
  /**
   * Block sound effects.
   * @private
   * @type {!gf.audio.SoundBank}
   */
  this.blockSoundBank_ = blk.assets.audio.BlockSounds.create(
      this.game.getAssetManager(), this.game.getAudioManager().context);
  this.game.getAudioManager().loadSoundBank(this.blockSoundBank_);

  /**
   * Player listing.
   * @private
   * @type {!Array.<!blk.sim.Player>}
   */
  this.players_ = [];

  /**
   * The local player, if it has been received yet.
   * @private
   * @type {blk.sim.Player}
   */
  this.localPlayer_ = null;

  // Simulated latency
  var launchOptions = this.game.launchOptions;
  this.session.socket.simulatedLatency = launchOptions.simulatedLatency;

  // Say hi
  this.console_.log('wsad to move');
  this.console_.log('left click to place blocks, right click to remove');
  if (!this.session.isLocal()) {
    this.console_.log('t to chat');
  }
};
goog.inherits(blk.game.client.ClientController, goog.Disposable);


/**
 * Gets the client simulator.
 * @return {!gf.sim.ClientSimulator} Client-side simulation.
 */
blk.game.client.ClientController.prototype.getSimulator = function() {
  return this.simulator_;
};


/**
 * @return {!blk.env.client.ClientMap} Game map.
 */
blk.game.client.ClientController.prototype.getMap = function() {
  return this.map_;
};


/**
 * @return {!gf.vec.Viewport} Screen viewport.
 */
blk.game.client.ClientController.prototype.getScreenViewport = function() {
  return this.screenViewport_;
};


/**
 * Gets a list of all currently connected players.
 * Do not modify the results. The results may change at any time.
 * @return {!Array.<!blk.sim.Player>} A list of players.
 */
blk.game.client.ClientController.prototype.getPlayerList = function() {
  return this.players_;
};


/**
 * Gets a player by session ID.
 * @param {string} sessionId User session ID.
 * @return {blk.sim.Player} Player, if found.
 */
blk.game.client.ClientController.prototype.getPlayerBySessionId =
    function(sessionId) {
  var user = this.session.getUserBySessionId(sessionId);
  if (user) {
    return /** @type {blk.sim.Player} */ (user.data);
  }
  return null;
};


/**
 * Gets a player by wire ID.
 * @param {number} wireId User wire ID.
 * @return {blk.sim.Player} Player, if found.
 */
blk.game.client.ClientController.prototype.getPlayerByWireId =
    function(wireId) {
  var user = this.session.getUserByWireId(wireId);
  if (user) {
    return /** @type {blk.sim.Player} */ (user.data);
  }
  return null;
};


/**
 * @return {blk.sim.Player} The local player.
 */
blk.game.client.ClientController.prototype.getLocalPlayer = function() {
  return this.localPlayer_;
};


/**
 * Handles player change events.
 * Called when a player joins, leaves, or updates their metadata.
 * @protected
 */
blk.game.client.ClientController.prototype.handlePlayersChanged =
    goog.nullFunction;


/**
 * Adds a widget to the game screen.
 * @protected
 * @param {!blk.ui.Widget} widget Widget to add.
 */
blk.game.client.ClientController.prototype.addWidget = function(widget) {
  // TODO(benvanik): add more logic around widget lifetimes/etc
  this.widgets_.push(widget);
  this.registerDisposable(widget);
  widget.enterDocument();
};


/**
 * Loads any resources required by the controller before the game can start.
 * @return {!goog.async.Deferred} A deferred fulfilled when the client is ready.
 */
blk.game.client.ClientController.prototype.load = function() {
  var deferred = new goog.async.Deferred();
  // TODO(benvanik): wait on initial asset load?
  deferred.callback(null);
  return deferred;
};


/**
 * Handles connection events.
 * When this is called the user is fully connected and ready to interact with
 * the server.
 * @protected
 */
blk.game.client.ClientController.prototype.handleConnected = function() {
};


/**
 * Handles disconnection events.
 * This may occur either by user choice or some other reason. Once it is called
 * the server should be considered unreachable.
 * @protected
 * @param {gf.net.DisconnectReason} reason Disconnect reason.
 */
blk.game.client.ClientController.prototype.handleDisconnect = function(reason) {
  var message = 'Disconnected: ' + gf.net.DisconnectReason.toString(reason);
  this.console_.log(message);

  // Stop the game
  this.game.playPlayerLeave();
  this.game.stopTicking();

  // TODO(benvanik): cleanup players/etc?

  // Display disconnection dialog
  blk.ui.screens.StatusScreen.showDisconnected(
      this.game.getScreenManager(), this.game.getDisplay().getDomElement(),
      reason).addCallback(function(buttonId) {
    // TODO(benvanik): make the dialog go to the main menu instead
    if (buttonId == 'reload') {
      window.location.reload(false);
    } else {
      window.location.href = 'http://google.com';
    }
  });
};


/**
 * Handles game-ending errors.
 * @protected
 * @param {string} message Error message.
 * @param {*=} opt_arg Optional argument.
 */
blk.game.client.ClientController.prototype.handleError =
    function(message, opt_arg) {
  // Log the error
  gf.log.write('Error: ' + message, opt_arg);
  this.console_.log('Error: ' + message, opt_arg);

  // Graceful disconnect
  // TODO(benvanik): log with server?
  this.session.disconnect();

  // Stop the game
  this.game.playPlayerLeave();
  this.game.stopTicking();

  // Display error dialog
  blk.ui.screens.StatusScreen.showError(
      this.game.getScreenManager(), this.game.getDisplay().getDomElement(),
      'game', message, opt_arg).addCallback(function(buttonId) {
    // TODO(benvanik): make the dialog go to the main menu instead
    if (buttonId == 'reload') {
      window.location.reload(false);
    } else {
      window.location.href = 'http://google.com';
    }
  });
};


/**
 * Refreshes settings from the user settings object.
 */
blk.game.client.ClientController.prototype.refreshSettings = function() {
  var settings = this.game.settings;

  // Update username
  var user = this.session.getLocalUser();
  goog.asserts.assert(user);
  var userInfo = user.info.clone();
  userInfo.displayName = settings.userName;
  this.session.updateUserInfo(userInfo);
};


/**
 * Maximum amount of time, in ms, the network poll is allowed to take.
 * @private
 * @const
 * @type {number}
 */
blk.game.client.ClientController.MAX_NETWORK_POLL_TIME_ = 2;


/**
 * Updates the game contents.
 * @param {!gf.UpdateFrame} frame Current update frame.
 */
blk.game.client.ClientController.prototype.update = function(frame) {
  // Ignore updating when disconnected/stopped
  if (this.session.state == gf.net.SessionState.DISCONNECTED) {
    return;
  }

  // Poll for network activity
  this.session.poll(blk.game.client.ClientController.MAX_NETWORK_POLL_TIME_);

  // Check for new disconnection
  if (this.session.state == gf.net.SessionState.DISCONNECTED) {
    this.handleDisconnect(this.session.disconnectReason);
    return;
  }

  // Update game state
  this.map_.update(frame);

  // Update simulation
  this.simulator_.update(frame);

  // Update UI bits
  this.console_.update(frame);
};


/**
 * Interpolation delay time, in seconds.
 * Higher values will cause greater time shifting beheavior but help to smooth
 * out laggy players.
 * TODO(benvanik): pull from config
 * @private
 * @const
 * @type {number}
 */
blk.game.client.ClientController.INTERPOLATION_DELAY_ = 300 / 1000;


/**
 * Renders the screen contents.
 * @param {!gf.RenderFrame} frame Current render frame.
 */
blk.game.client.ClientController.prototype.render = function(frame) {
  // Ignore rendering when disconnected/stopped
  if (this.session.state == gf.net.SessionState.DISCONNECTED) {
    return;
  }

  // Reset screen viewport
  var display = this.game.getDisplay();
  this.screenViewport_.reset(display.getSize());

  // Grab latest input data as early in the frame as possible
  this.inputData_.poll();

  // Handle user input
  // Let the console eat the data first, if it wants to
  if (!this.console_.processInput(frame, this.inputData_)) {
    this.processInput(frame, this.inputData_);
  }

  // Process physics
  this.processPhysics(frame);

  // Timeshift by interpolation delay
  // This ensures we render at the time we should be
  // (I think ;)
  var originalFrameTime = frame.time;
  frame.time -= blk.game.client.ClientController.INTERPOLATION_DELAY_;
  this.simulator_.interpolateEntities(frame.time);

  // Render the game
  var graphicsContext = this.game.getGraphicsContext();
  if (graphicsContext.begin()) {
    // Draw the frame
    this.beginDrawing(frame);
    this.drawWorld(frame);
    this.drawOverlays(frame, this.inputData_);
    this.endDrawing(frame);

    graphicsContext.end();
  }

  // Restore time
  frame.time = originalFrameTime;

  // Reset input data cache
  this.inputData_.reset();
};


/**
 * Processes new input data.
 * @protected
 * @param {!gf.RenderFrame} frame Current render frame.
 * @param {!gf.input.Data} inputData Updated input data.
 * @return {boolean} True if the input was handled exclusively.
 */
blk.game.client.ClientController.prototype.processInput =
    function(frame, inputData) {
  return false;
};


/**
 * Processes physics and movement.
 * @protected
 * @param {!gf.RenderFrame} frame Current render frame.
 */
blk.game.client.ClientController.prototype.processPhysics = function(frame) {
};


/**
 * Begins drawing the game.
 * Called immediately after the render state has been reset.
 * @protected
 * @param {!gf.RenderFrame} frame Current render frame.
 */
blk.game.client.ClientController.prototype.beginDrawing = function(frame) {
};


/**
 * Draws the map and entities to the screen.
 * @protected
 * @param {!gf.RenderFrame} frame Current render frame.
 */
blk.game.client.ClientController.prototype.drawWorld = function(frame) {
};


/**
 * Draws any overlays and UI to the screen.
 * @protected
 * @param {!gf.RenderFrame} frame Current render frame.
 * @param {!gf.input.Data} inputData Updated input data.
 */
blk.game.client.ClientController.prototype.drawOverlays =
    function(frame, inputData) {
  var mapStats = this.map_.getStatisticsString();
  var extraInfo = this.getDebugInfo();
  this.console_.render(frame, this.screenViewport_, mapStats, extraInfo);
};


/**
 * Gets additional debugging information that will be printed to the console.
 * @protected
 * @return {string?} Extra debugging information for the console.
 */
blk.game.client.ClientController.prototype.getDebugInfo = goog.nullFunction;


/**
 * Ends drawing the game.
 * @protected
 * Called immediately before ending the graphics context.
 * @param {!gf.RenderFrame} frame Current render frame.
 */
blk.game.client.ClientController.prototype.endDrawing = function(frame) {
};


/**
 * Plays the given audio cue at the position if it is within range.
 * @param {!gf.audio.SoundBank} soundBank Sound bank to play the cue from.
 * @param {string} cue Sound cue.
 * @param {!goog.vec.Vec3.Float32} position World position to play the sound at.
 */
blk.game.client.ClientController.prototype.playPointSound =
    function(soundBank, cue, position) {
  // TODO(benvanik): add dampening factor/etc based on line of sight

  var listener = this.game.getAudioManager().listener;
  var distance = listener.getDistance(position);
  if (distance < blk.env.MAX_SOUND_DISTANCE) {
    if (!this.game.settings.soundFxMuted) {
      soundBank.playPoint(cue, position);
    }
  }
};


// // SIMDEPRECATED
// /**
//  * Sets a block and plays sound if required.
//  * Note that the block specified may have originated from the network and as
//  * such it may not be in our view but may be in the cache. Because of this,
//  * we must pass the change off to the map, which will try to update the
//  * chunk.
//  *
//  * @param {number} x Block X.
//  * @param {number} y Block Y.
//  * @param {number} z Block Z.
//  * @param {number} blockData Block Data.
//  */
// blk.game.client.ClientController.prototype.setBlock =
//     function(x, y, z, blockData) {
//   var map = this.getMap();

//   var oldData = 0;
//   if (!blockData) {
//     oldData = map.getBlock(x, y, z);
//   }
//   var changed = map.setBlock(x, y, z, blockData);

//   // Play block sound, if any and only if needed
//   if (changed) {
//     var soundData = blockData ? blockData : oldData;
//     if (soundData >> 8) {
//       var block = map.blockSet.getBlockWithId(soundData >> 8);
//       var cue = block ? block.material.actionCue : null;
//       if (cue) {
//         var soundPosition = goog.vec.Vec3.createFloat32FromValues(x, y, z);
//         var soundBank = this.blockSoundBank_;
//         this.playPointSound(soundBank, cue, soundPosition);
//       }
//     }
//   }
// };


/**
 * @override
 */
blk.game.client.ClientController.prototype.entityAdded = function(entity) {
  if (entity instanceof blk.sim.Player) {
    var player = /** @type {!blk.sim.Player} */ (entity);

    // Add to roster
    var user = entity.getUser();
    user.data = player;
    this.players_.push(player);

    if (user == this.session.getLocalUser()) {
      this.localPlayer_ = player;
    }

    this.handlePlayersChanged();
    gf.log.write('got player entity');
  }
};


/**
 * @override
 */
blk.game.client.ClientController.prototype.entityRemoved = function(entity) {
  if (entity instanceof blk.sim.Player) {
    var player = /** @type {!blk.sim.Player} */ (entity);

    // Remove from roster
    goog.array.remove(this.players_, player);

    if (player == this.localPlayer_) {
      // Hrm - deleting self?
      gf.log.debug('Server deleted client entity while connected');
    }

    this.handlePlayersChanged();
  }
};


/**
 * Sets up the packet switching handlers for the service.
 * @protected
 * @param {!gf.net.PacketSwitch} packetSwitch Packet switch.
 */
blk.game.client.ClientController.prototype.setupSwitch =
    function(packetSwitch) {
  packetSwitch.register(
      blk.net.packets.ChunkData.ID,
      this.handleChunkData_, this);
  packetSwitch.register(
      blk.net.packets.ReadyPlayer.ID,
      this.handleReadyPlayer_, this);
};


/**
 * @override
 */
blk.game.client.ClientController.prototype.userConnected =
    function(user) {
  // Play a sound
  this.game.playPlayerJoin();

  this.console_.log(
      user.info.displayName + ' (' + user.sessionId + ') connected on ' +
      user.agent.toString());
};


/**
 * @override
 */
blk.game.client.ClientController.prototype.userDisconnected =
    function(user) {
  // Play a sound
  this.game.playPlayerLeave();

  this.console_.log(
      user.info.displayName + ' (' + user.sessionId + ') disconnected:',
      gf.net.DisconnectReason.toString(user.disconnectReason));
};


/**
 * @override
 */
blk.game.client.ClientController.prototype.userUpdated =
    function(user) {
  // SIMDEPRECATED
  var player = this.getPlayerBySessionId(user.sessionId);
  // if (player && player.entity) {
  //   player.entity.title = user.info.displayName;
  // }

  this.handlePlayersChanged();
};


/**
 * Handles chunk data packets.
 * @private
 * @param {!gf.net.Packet} packet Packet.
 * @param {number} packetType Packet type ID.
 * @param {!gf.net.PacketReader} reader Packet reader.
 * @return {boolean} True if the packet was handled successfully.
 */
blk.game.client.ClientController.prototype.handleChunkData_ =
    function(packet, packetType, reader) {
  var chunkData = blk.net.packets.ChunkData.read(reader);
  if (!chunkData) {
    return false;
  }

  var map = this.getMap();
  var chunkSerializer = blk.io.ChunkSerializer.getSharedSerializer();

  // Grab chunk from the cache, load
  var chunk = map.getChunk(chunkData.x, chunkData.y, chunkData.z);
  if (!chunkSerializer.deserializeFromReader(chunk, reader)) {
    // TODO(benvanik): signal load failure? set state?
    return false;
  }

  // TODO(benvanik): maybe fade in?

  return true;
};


/**
 * Handles player ready packets.
 * @private
 * @param {!gf.net.Packet} packet Packet.
 * @param {number} packetType Packet type ID.
 * @param {!gf.net.PacketReader} reader Packet reader.
 * @return {boolean} True if the packet was handled successfully.
 */
blk.game.client.ClientController.prototype.handleReadyPlayer_ =
    function(packet, packetType, reader) {
  var readyPlayer = blk.net.packets.ReadyPlayer.read(reader);
  if (!readyPlayer) {
    return false;
  }

  // All map data has been transferred, ready!
  //this.game.makeReady();

  return true;
};


// // SIMDEPRECATED
// /**
//  * Handles entity position packets.
//  * @private
//  * @param {!gf.net.Packet} packet Packet.
//  * @param {number} packetType Packet type ID.
//  * @param {!gf.net.PacketReader} reader Packet reader.
//  * @return {boolean} True if the packet was handled successfully.
//  */
// blk.game.client.ClientController.prototype.handleEntityPosition_ =
//     function(packet, packetType, reader) {
//   var entityPosition = blk.net.packets.EntityPosition.read(reader);
//   if (!entityPosition) {
//     return false;
//   }

//   // Update local movement
//   var localPlayer = this.getLocalPlayer();
//   localPlayer.confirmMovementSequence(entityPosition.sequence);

//   // Update entity positions
//   var map = this.getMap();
//   for (var n = 0; n < entityPosition.states.length; n++) {
//     var entityState = entityPosition.states[n];
//     entityState.time /= 1000;
//     var entity = map.getEntity(entityState.entityId);
//     if (entity) {
//       if (entity.player == localPlayer) {
//         // Update entity confirmed state
//         entity.confirmedState.setFromState(entityState);
//       } else {
//         // Others
//         // TODO(benvanik): lerp
//         entity.updateState(entityState);
//       }
//     }
//   }

//   return true;
// };


/**
 * @override
 */
blk.game.client.ClientController.prototype.connected = goog.nullFunction;


/**
 * @override
 */
blk.game.client.ClientController.prototype.disconnected = goog.nullFunction;
