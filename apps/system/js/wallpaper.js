/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

//
// This module sets the wallpaper for the system app, but does so by defining
// a Wallpaper.addListener() utility function that is also used by the
// lockscreen module.
// 
// In addition to being convienient, this module also has the
// important function of storing the system default wallpaper image
// into the database on the first run.
//
var Wallpaper = (function() {

  var currentWallpaperURL;
  var listeners = [];
  var defaultImage = 'resources/images/backgrounds/default.png';


  SettingsListener.observe('wallpaper.image', null, function wallpaper(blob) {
    var oldWallpaperURL = currentWallpaperURL;

    if (blob === null) {
      // If there was nothing in the settings database, we use our default
      currentWallpaperURL = defaultImage;

      // And store that default image, as a blob, into the settings database
      // so that apps that query the wallpaper always get a valid blob
      console.log('First run: storing wallpaper as blob in settings db');
      storeWallpaperBlob(defaultImage);
    }
    else {
      // Otherwise, the value is a blob, and we need to create a blob url
      // for it.
      try {
        currentWallpaperURL = URL.createObjectURL(blob);
      }
      catch(e) {
        console.error("Error creating wallpaper blob", e);
      }
    }

    // Pass this new wallpaper URL to all registered listeners
    // XXX: should I pass the default image, or wait to be called again when
    // it is converted to a blob?
    console.log('New wallpaper:', currentWallpaperURL);
    listeners.forEach(function(listener) {
      try {
        listener(currentWallpaperURL);
      }
      catch(e) {
        console.error(e);
      }
    });

    // If the old wallpaper URL was a blob URL, revoke it
    if (oldWallpaperURL && oldWallpaperURL.substring(0,5) === 'blob:') {
      URL.revokeObjectURL(oldWallpaperURL);
    }
  });
  
  function storeWallpaperBlob(url) {
    var img = new Image();
    img.src = url;
    img.onload = function() {
      var canvas = document.createElement('canvas');
      var context = canvas.getContext('2d');
      canvas.width = img.width;
      canvas.height = img.height;
      context.drawImage(img, 0, 0);
      canvas.toBlob(function(blob) {
        navigator.mozSettings.createLock().set({
          'wallpaper.image': blob
        });
      });
    };
  }

  function addListener(listener) {
    if (currentWallpaperURL) {
      try {
        listener(currentWallpaperURL);
      }
      catch(e) {
        console.error(e);
      }
    }
    listeners.push(listener);
  }

  return {
    addListener: addListener
  };
}());

Wallpaper.addListener(function(url) {
  document.getElementById('screen').style.backgroundImage =
    'url(' + url + ')';
});
