'use strict';

//
// The PlaylistServiceIACProxy class listens for messages from an IAC port
// and translates them into PlaylistService calls.  And it listens for state
// change events from the PlaylistService and translates posts the new state
// data to the IAC port. This enables the app on the other side of the IAC
// connection to have a local version of the PlaylistService API.
//
function PlaylistServiceIACProxy(port) {
  this.port = port;
  port.onmessage = this.handleIACMessage.bind(this);

  this.playlistServiceListener = this.sendIACMessage.bind(this);
  PlaylistService.addListener(this.playlistServiceListener);
}

PlaylistServiceIACProxy.prototype.handleIACMessage = function(event) {
  var command = event.data.command;
  var argument = event.data.argument;

  if (command === 'requeststate') {
    this.port.postMessage({
      command: 'stateresponse',
      argument: PlaylistService.getState()
    });
  }
  else if (PlaylistService[command]) {
    PlaylistService[command](argument);
  }
};

PlaylistServiceIACProxy.prototype.sendIACMessage = function(state) {
  // XXX: catch errors here and call shutdown if the port is closed?
  // Or do I get an event when the port closes? Or can I just ask it
  // if it is closed?
  this.port.postMessage({
    command: 'statechanged'
    argument: state
  });
};

// When the app on the other side of the IAC connection dies, we need to
// remove the listeners so that this proxy object can be garbage collected.
// XXX: how do I find out when the app has died?
PlaylistServiceIACProxy.prototype.shutdown = function() {
  this.port.onmessage = null;
  PlaylistService.removeListener(this.playlistServiceListener);
};

//
// This static init method listens for "mediacomms" IAC connections
// from other apps and creates a new proxy object for each one.
//
PlaylistServiceIACProxy.init = function init() {
  window.navigator.mozSetMessageHandler('connection', function(request) {
    if (request.keyword === 'mediacomms') {
      new PlaylistServiceIACProxy(request.port);
    }
  });
};

PlaylistServiceIACProxy.init();
