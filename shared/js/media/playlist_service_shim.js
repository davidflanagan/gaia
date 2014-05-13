(function(exports) {
  'use strict';

  var queuedMessages = [];
  var iacPorts;
  var listeners = [];
  var stateRequestCallbacks[];

  // Set up Inter-App Communications
  navigator.mozApps.getSelf().onsuccess = function() {
    var app = this.result;

    app.connect('mediacomms').then(function(ports) {
      iacPorts = ports;
      ports.forEach(function(port) {
        port.onmessage = handleIACMessage;

        queuedMessages.forEach(function(message) {
          port.postMessage(message);
        });
      });
      queuedMessages = null;
    });
  };

  function handleIACMessage(message) {
    if (message.command === 'statechanged') {
      listeners.forEach(function(listener) {
        listener(message.argument);
      });
    }
    else if (message.command === 'stateresponse') {
      var callback = stateRequestCallbacks.shift();
      if (callback) {
        callback(message.argument);
      }
    }
  }

  function postMessage(message) {
    if (iacPorts) {
      iacPorts.forEach(function(port) {
        port.postMessage(message);
      });
    }
    else {
      queuedMessages.push(iacPorts);
    }
  }

  function addListener(listener) {
    listeners.push(listener);
  }

  function removeListener(listener) {
    var index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  function requestState(callback) {
    stateRequestCallbacks.push(callback);
    postMessage({command: 'requestState'});
  }

  exports.PlaylistService = {
    play: function play() { postMessage({command: 'play'}); },
    pause: function pause() { postMessage({command: 'pause'}); },
    next: function next() { postMessage({command: 'next'}); },
    previous: function previous() { postMessage({command: 'previous'}); },
    newPlaylist: function newPlaylist() {
      postMessage({command: 'newPlaylist'});
    },
    addTrack: function addTrack(track) {
      postMessage({command: 'addTrack', argument: track});
    },
    requestState: requestState,
    addListener: addListener,
    removeListener: removeListener
  };

}(window));
