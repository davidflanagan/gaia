'use strict';

function MediaPlaybackWidget(container, options) {
  this.container = container;
  this.nowPlaying = container.querySelector('.media-playback-nowplaying');
  this.controls = container.querySelector('.media-playback-controls');

  this.icon = container.querySelector('.icon');
  this.trackTitle = container.querySelector('.title');
  this.trackArtist = container.querySelector('.artist');
  this.albumArt = container.querySelector('.albumart');

  this.previousButton = container.querySelector('.previous');
  this.playPauseButton = container.querySelector('.play-pause');
  this.nextButton = container.querySelector('.next');

  this.previousButton.addEventListener('click', function() {
    PlaylistService.previous();
  });

  this.nextButton.addEventListener('click', function() {
    PlaylistService.next();
  });

  this.playPauseButton.addEventListener('click', function() {
    if (this.playPauseButton.classList.contains('is-paused')) {
      PlaylistService.play();
    }
    else {
      PlaylistService.pause();
    }
  });

  PlaylistService.addListener(this.playlistStateChanged.bind(this));


  // When SCO status changes, we need to adjust the ui of the playback controls
  window.addEventListener(
    'bluetoothprofileconnectionchange', this.handleSCOChange.bind(this)
  );
}

MediaPlaybackWidget.prototype = {
/*
  set playStatus(status) {
    return MediaAppAgent.playStatus = status;
  },

  set position(position) {
    return MediaAppAgent.position = position;
  },
*/
  get hidden() {
    return this.container.hidden;
  },

  set hidden(value) {
    return this.container.hidden = value;
  },

  oldstate: {
    metadata: {}
  },

  playlistStateChanged: function mpw_handleMessage(state) {
    var oldstate = this.oldstate;

    if (state.metadata.title !== oldstate.metadata.title) {
      this.trackTitle.textContent = state.metadata.title || '';
    }

    if (state.metadata.artist !== oldstate.metadata.artist) {
      this.trackArtist.textContent = state.metadata.artist || '';
    }

    // XXX: add album art here

    if (state.paused !== oldstate.paused) {
      if (state.paused) {
        this.playPauseButton.classList.add('is-paused');
      }
      else {
        this.playPauseButton.classList.remove('is-paused');
      }
    }

    this.nextButton.disabled = !state.hasNext;
    this.previousButton.disabled = !state.hasPrevious;

    // If there aren't any tracks in the playlist hide the entire widget
    this.hidden = !state.hasAny;

    this.oldstate = state;
  },

  handleSCOChange: function mpw_handleSCOChange(event) {
    var name = event.detail.name;
    var connected = event.detail.connected;

    if (name === Bluetooth.Profiles.SCO)
      this.container.classList.toggle('disabled', connected);
  }

/*
  updateAppInfo: function mpw_updateAppInfo(info) {
    if (!info)
      return;

    this.origin = info.origin;
    this.icon.style.backgroundImage = 'url(' + info.icon + ')';
  },
*/

/*
  openMediaApp: function mp_openMediaApp(event) {
    if (this.origin) {
      var evt = new CustomEvent('displayapp', {
        bubbles: true,
        cancelable: true,
        detail: { origin: this.origin }
      });
      window.dispatchEvent(evt);
    }
  },
*/
};
