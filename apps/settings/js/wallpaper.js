/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

(function() {
  // We preview the current wallpaper in this element
  var preview = document.getElementById('wallpaper-preview');

  // Click on it to select new wallpaper
  preview.addEventListener('click', pickNewWallpaper);

  // Query the current wallpaper and display it
  var req = navigator.mozSettings.createLock().get('wallpaper.image');
  req.onsuccess = function onWallpaperSuccess() {
    previewWallpaper(req.result['wallpaper.image']);
  };
  
  // Listen for wallpaper changes, and update the display
  navigator.mozSettings.addObserver('wallpaper.image', function(e) {
    previewWallpaper(e.settingValue);
  });
  
  // This function takes the wallpaper as a blob and displays it 
  // in the preview image
  function previewWallpaper(blob) {
    var oldurl = preview.src;
    console.log('previewWallpaper', blob, typeof blob, JSON.stringify(blob));
    var newurl = URL.createObjectURL(blob);
    preview.src = newurl;
    if (oldurl && oldurl.substring(0,5) === 'blob:')
      URL.revokeObjectURL(oldurl);
  }

  // This function picks a new wallpaper image and saves the blob
  // to the settings database.
  function pickNewWallpaper() {
    var a = new MozActivity({
      name: 'pick',
      data: {
        type: 'image/jpeg',
        width: 320,
        height: 480
      }
    });

    a.onsuccess = function onPickSuccess() {
      if (!a.result.blob) {
        console.warn('Pick activity did not return a blob');
        return;
      }
      var setrequest = navigator.mozSettings.createLock().set({
        'wallpaper.image': a.result.blob
      });
      
      setrequest.onerror = function onSetError() {
        console.warn('failed to set wallpaper', setrequest.error);
      };
    };
 
   a.onerror = function onPickError() {
      console.warn('pick failed!');
    };
  }
}());

