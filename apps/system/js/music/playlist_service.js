'use strict';

var PlaylistService = {
  playlist: [],        // all of the songs and metadata we know about
  tracknum: 0,         // the index of the currently playing track
  player: new Audio(), // the <audio> element that plays songs
  listeners: [],       // functions to call when our state changes
  storage: navigator.getDeviceStorage('pictures'),  // for retrieving files

  init: function PLS_init() {
    this.player.autoplay = true;
    this.player.addEventListener('playing', this);
    this.player.addEventListener('paused', this);
    this.player.addEventListener('ended', this);
  },

  play: function PLS_play() {
    if (this.playlist.length === 0)
      return;

    if (this.player.src !== null) {
      // If there is already something loaded in the player, we're just
      // resuming from a pause.
      this.player.play();
    }
    else {
      // Otherwise, this is the first time we're loading a file
      this.playTrack(this.tracknum);
    }
  },

  pause: function PLS_pause() {
    this.player.pause();
  },

  next: function PLS_next() {
    if (this.tracknum < this.playlist.length - 1) {
      this.tracknum++;
      this.playTrack(this.tracknum);
    }
  },

  previous: function PLS_previous() {
    if (this.tracknum > 1) {
      this.tracknum--;
      this.playTrack(this.tracknum);
    }
  },

  newPlaylist: function PLS_newPlaylist() {
    this.playlist = [];
    this.tracknum = 0;
    // Unload any currently playing song.
    this.player.src = '';
    this.player.load();

    // XXX may have to send state explictly here
  },

  addTrack: function PLS_addTrack(track) {
    this.playlist.push(track);
  },

  addListener: function PLS_addListener(listener) {
    this.listeners.push(listener);
  },

  removeListener: function PLS_removeListener(listener) {
    var index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  },

  requestState: function PLS_requestState(callback) {
    var self = this;
    setTimeout(function() {
      callback(self.getState());
    });
  },

  getState: function PLS_getState() {
    var n = this.tracknum;
    var track = this.playlist[n];

    return {
      // Metadata about the track. This is just stuff that was passed in
      // with the call to addTrack
      metadata: track.metadata || {},

      // Information about the playlist
      hasAny: this.playlist.length > 0,
      hasNext: n !== -1 && n < this.playlist.length - 1,
      hasPrevious: n > 0,

      // Information from the audio element
      currentTime: this.player.currentTime,
      duration: this.player.duration,
      paused: this.player.paused,

      // Domain of the app that added the track, for display as an icon
      // on the notification screen.
      // XXX: implement this if we actually need it
      app: null
    };
  },

  playTrack: function PLS_playTrack(n) {
    if (n < 0 || n >= this.playlist.length)
      return;

    var self = this;
    var track = this.playlist[n];
    var request = this.storage.get(track.filename);

    request.onerror = function() {
      // If the file does not exist, remove the track from the playlist
      self.playlist.splice(n, 1);

      // If there is still a file to play, play it instead of the broken one.
      // Otherwise, just skip back to the start of the playlist and play nothing
      if (n < self.playlist.length) {
        self.playTrack(n);
      }
      else {
        self.tracknum = 0;
      }
    };

    request.onsuccess = function() {
      if (self.player.src) {
        URL.revokeObjctURL(self.player.src);
      }
      self.player.src = URL.createObjectURL(request.result);
      self.player.load();
      self.player.play();
    };
  },

  // Any time we get an event from the audio element, we have to
  // tell all of our listeners about it. Note that the play/pause/next/prev
  // methods will cause events on the audio element that will trigger
  // this method.
  handleEvent: function(event) {
    var state = this.getState();
    this.listeners.forEach(function(listener) {
      listener(state);
    });
  }
};

PlaylistService.init();
