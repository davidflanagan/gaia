'use strict';

const Wallpaper = (function() {
  var overlay = document.getElementById('icongrid');

  function onHomescreenContextmenu() {
    var a = new MozActivity({
      name: 'pick',
      data: {
        type: 'image/jpeg',
        width: 320,
        height: 480
      }
    });
    a.onsuccess = function onWallpaperSuccess() {
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

    a.onerror = function onWallpaperError() {
      console.warn('pick failed!');
    };
  }

  return {
    init: function init() {
      overlay.addEventListener('contextmenu', onHomescreenContextmenu);
    }
  };
})();
