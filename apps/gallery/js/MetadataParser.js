'use strict';

//
// This file defines a single metadataParsers object. The two
// properties of this object are metadata parsing functions for image
// files and video files, intended for use with the MediaDB class.
//
// This file depends on JPEGMetadataParser.js and blobview.js
//
var metadataParser = (function() {
  // If we generate our own thumbnails, aim for this size.
  // Calculate needed size from longer side of the screen.
  var THUMBNAIL_WIDTH = computeThumbnailWidth();
  var THUMBNAIL_HEIGHT = THUMBNAIL_WIDTH;
  function computeThumbnailWidth() {
    // Make sure this works regardless of current device orientation
    var portraitWidth = Math.min(window.innerWidth, window.innerHeight);
    var landscapeWidth = Math.max(window.innerWidth, window.innerHeight);
    var thumbnailsPerRowPortrait = isPhone ? 3 : 4;
    var thumbnailsPerRowLandscape = isPhone ? 4 : 6;
    return Math.round(window.devicePixelRatio *
             Math.max(portraitWidth / thumbnailsPerRowPortrait,
                      landscapeWidth / thumbnailsPerRowLandscape));
  }
  // Don't try to decode image files of unknown type if bigger than this
  var MAX_UNKNOWN_IMAGE_FILE_SIZE = .5 * 1024 * 1024; // half a megabyte


  // An <img> element for loading images
  var offscreenImage = new Image();

  // The screen size. Preview images must be at least this big
  var sw = window.innerWidth * window.devicePixelRatio;
  var sh = window.innerHeight * window.devicePixelRatio;

  // Create a thumbnail size canvas, copy the <img> or <video> into it
  // cropping the edges as needed to make it fit, and then extract the
  // thumbnail image as a blob and pass it to the callback.
  // This utility function is used by both the image and video metadata parsers
  function createThumbnailFromElement(elt, video, rotation,
                                      mirrored, callback, error) {
    try {
      // Create a thumbnail image
      var canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = THUMBNAIL_HEIGHT;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      var eltwidth = elt.width;
      var eltheight = elt.height;
      var scalex = canvas.width / eltwidth;
      var scaley = canvas.height / eltheight;

      // Take the larger of the two scales: we crop the image to the thumbnail
      var scale = Math.max(scalex, scaley);

      // Calculate the region of the image that will be copied to the
      // canvas to create the thumbnail
      var w = Math.round(THUMBNAIL_WIDTH / scale);
      var h = Math.round(THUMBNAIL_HEIGHT / scale);
      var x = Math.round((eltwidth - w) / 2);
      var y = Math.round((eltheight - h) / 2);

      var centerX = Math.floor(THUMBNAIL_WIDTH / 2);
      var centerY = Math.floor(THUMBNAIL_HEIGHT / 2);

      // If a orientation is specified, rotate/mirroring the canvas context.
      if (rotation || mirrored) {
        context.save();
        // All transformation are applied to the center of the thumbnail.
        context.translate(centerX, centerY);
      }
      if (mirrored) {
        context.scale(-1, 1);
      }
      if (rotation) {
        switch (rotation) {
        case 90:
          context.rotate(Math.PI / 2);
          break;
        case 180:
          context.rotate(Math.PI);
          break;
        case 270:
          context.rotate(-Math.PI / 2);
          break;
        }
      }

      if (rotation || mirrored) {
        context.translate(-centerX, -centerY);
      }

      // Draw that region of the image into the canvas, scaling it down
      context.drawImage(elt, x, y, w, h,
                        0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

      // Restore the default rotation so the play arrow comes out correctly
      if (rotation || mirrored) {
        context.restore();
      }

      // If this is a video, superimpose a translucent play button over
      // the captured video frame to distinguish it from a still photo thumbnail
      if (video) {
        // First draw a transparent gray circle
        context.fillStyle = 'rgba(0, 0, 0, .2)';
        context.beginPath();
        context.arc(THUMBNAIL_WIDTH / 2, THUMBNAIL_HEIGHT / 2,
                    THUMBNAIL_HEIGHT / 5, 0, 2 * Math.PI, false);
        context.fill();

        // Now outline the circle in white
        context.strokeStyle = 'rgba(255,255,255,.6)';
        context.lineWidth = 2;
        context.stroke();

        // And add a white play arrow.
        context.beginPath();
        context.fillStyle = 'rgba(255,255,255,.6)';
        // The height of an equilateral triangle is sqrt(3)/2 times the side
        var side = THUMBNAIL_HEIGHT / 5;
        var triangle_height = side * Math.sqrt(3) / 2;
        context.moveTo(THUMBNAIL_WIDTH / 2 + triangle_height * 2 / 3,
                       THUMBNAIL_HEIGHT / 2);
        context.lineTo(THUMBNAIL_WIDTH / 2 - triangle_height / 3,
                       THUMBNAIL_HEIGHT / 2 - side / 2);
        context.lineTo(THUMBNAIL_WIDTH / 2 - triangle_height / 3,
                       THUMBNAIL_HEIGHT / 2 + side / 2);
        context.closePath();
        context.fill();
      }

      canvas.toBlob(function(blob) {
        context = null;
        canvas.width = canvas.height = 0;
        canvas = null;
        callback(blob);
      }, 'image/jpeg');
    } catch (ex) {
      // An error may be thrown when the drawImage decodes a broken/trancated
      // image.
      // The elt may be a offscreen image. So, the image metadata is parsed, and
      // the image data is loaded but not decoded. The drawImage triggers the
      // image decoder to decode the image data. And an error may be thrown.
      error('createThumbnailFromElement:' + ex.message);
    }
  }

  var VIDEOFILE = /DCIM\/\d{3}MZLLA\/VID_\d{4}\.jpg/;

  function metadataParser(file, metadataCallback, metadataError, bigFile) {
    // If the file is a poster image for a video file, then we've want
    // video metadata, not image metadata
    if (VIDEOFILE.test(file.name)) {
      videoMetadataParser(file, metadataCallback, metadataError);
      return;
    }

    // Figure out how big the image is if we can. For JPEG files this
    // calls the JPEG parser and returns the EXIF preview if there is one.
    getImageSize(file, gotImageSize, gotImageSizeError);

    function gotImageSizeError(errmsg) {
      // The image is not a JPEG, PNG or GIF file. We may still be
      // able to decode and display it but we don't know the image
      // size, so we won't even try if the file is too big.
      if (file.size > MAX_UNKNOWN_IMAGE_FILE_SIZE) {
        metadataError('Ignoring large file ' + file.name);
        return;
      }

      // If the file is too small to be an image, ignore it
      if (file.size < 32) {
        metadataError('Ignoring small file ' + file.name);
        return;
      }

      // If the error message is anything other than unknown image type
      // it means we've got a corrupt image file, or the image metdata parser
      // can't handle the file for some reason. Log a warning but keep going
      // in case the image is good and the metadata parser is buggy.
      if (errmsg !== 'unknown image type') {
        console.warn('getImageSize', errmsg, file.name);
      }

      // If it is not too big create a preview and thumbnail.
      createThumbnailAndPreview(file,
                                metadataCallback,
                                metadataError,
                                false,
                                bigFile,
                                {});
    }

    function gotImageSize(metadata) {
      // If the image is too big, reject it now so we don't have
      // memory trouble later.
      // CONFIG_MAX_IMAGE_PIXEL_SIZE is maximum image resolution we can handle.
      // It's from config.js which is generated in build time, 5 megapixels by
      // default (see build/application-data.js). It should be synced with
      // Camera app and update carefully.
      if (metadata.width * metadata.height > CONFIG_MAX_IMAGE_PIXEL_SIZE) {
        metadataError('Ignoring high-resolution image ' + file.name);
        return;
      }

      // If the file included a preview image, see if it is big enough
      if (metadata.preview) {
        // Create a blob that is just the preview image
        var previewblob = file.slice(metadata.preview.start,
                                     metadata.preview.end,
                                     'image/jpeg');

        // Check to see if the preview is big enough to use in MediaFrame
        parseJPEGMetadata(previewblob, previewsuccess, previewerror);
      }
      else {
        // If there wasn't a preview image, then generate a preview and
        // thumbnail from the full size image.
        useFullsizeImage();
      }

      function previewerror(msg) {
        // The preview isn't a valid jpeg file, so use the full image to
        // create a preview and a thumbnail
        console.error(msg);
        useFullsizeImage();
      }

      function useFullsizeImage() {
        // Since a number of different cases use the same fallback method
        // define it in one place for easier code flow.
        createThumbnailAndPreview(file,
                                  metadataCallback,
                                  metadataError,
                                  false,
                                  bigFile,
                                  metadata);
      }

      function previewsuccess(previewmetadata) {
        // Size of the preview image
        var pw = previewmetadata.width;
        var ph = previewmetadata.height;
        // optional configuration specifying minimum size
        var mw = CONFIG_REQUIRED_EXIF_PREVIEW_WIDTH;
        var mh = CONFIG_REQUIRED_EXIF_PREVIEW_HEIGHT;

        var bigenough;

        // If config.js specifies a minimum required preview size,
        // then this preview is big enough if both dimensions are
        // larger than that configured minimum. Otherwise, the preview
        // is big enough if at least one dimension is >= the screen
        // size in both portait and landscape mode.
        if (mw && mh) {
          bigenough =
            Math.max(pw, ph) >= Math.max(mw, mh) &&
            Math.min(pw, ph) >= Math.min(mw, mh);
        }
        else {
          bigenough = (pw >= sw || ph >= sh) && (pw >= sh || ph >= sw);
        }

        // If the preview is big enough, use it to create a thumbnail.
        if (bigenough) {
          metadata.preview.width = pw;
          metadata.preview.height = ph;
          // The 4th argument true means don't actually create a preview
          createThumbnailAndPreview(previewblob,
                                    metadataCallback,
                                    previewerror,
                                    true,
                                    bigFile,
                                    metadata);
        } else {
          // Preview isn't big enough so get one the hard way
          useFullsizeImage();
        }
      }
    }
  }

  // Load an image from a file into an <img> tag, and then use that
  // to get its dimensions and create a thumbnail.  Store these values in
  // a metadata object, and pass the object to the callback function.
  // If anything goes wrong, pass an error message to the error function.
  // If it is a large image, create and save a preview for it as well.
  function createThumbnailAndPreview(file, callback, error, noPreviewNeeded,
                                     bigFile, metadata) {
    // This is the blob url of the blob we've been passed.
    var url = URL.createObjectURL(file);

    // We don't want to decode the blob at full size, however, so we'll add a
    // media fragment to request a smaller size. If we need to create a
    // preview we'll decode it at preview size.  If we only need to create
    // a thumbnail, we'll decode it at thumbnail size. Note that we can only
    // do this optimization if we know the width and height of the image.
    if (metadata.width && metadata.height) {

      var targetPreviewWidth, targetPreviewHeight;

      // Figure out the minimum size that the image can be displayed at so that
      // it will fit the screen in both landscape and portrait mode

      // Figure out the preview size.
      // Make sure the size is big enough for both landscape and portrait
      var previewScale = Math.max(Math.min(sw / metadata.width,
                                           sh / metadata.height,
                                           1),
                                  Math.min(sh / metadata.width,
                                           sw / metadata.height,
                                           1));
      var targetPreviewWidth = metadata.width * previewScale;
      var targetPreviewHeight = metadata.height * previewScale;

      // We don't need a preview if the image is small to begin with
      if (!noPreviewNeeded &&
          (previewScale === 1 ||
           metadata.width * metadata.height < 512 * 1024)) {
        noPreviewNeeded = true;
      }

      // In order to calculate the sample size, we've got to know the size
      // of the file or blob that we've been passed, and that depends on
      // whether we were passed the full file or an EXIF preview
      var originalWidth, originalHeight;
      var targetWidth, targetHeight;

      if (metadata.preview &&
          metadata.preview.width && metadata.preview.height)
      {
        // in this case, the file is just the EXIF preview
        originalWidth = metadata.preview.width;
        originalHeight = metadata.preview.height;
      }
      else {
        // in this case, the file is the full image
        originalWidth = metadata.width;
        originalHeight = metadata.height;
      }

      // We also need whether our target is a thumbnail or a preview
      if (noPreviewNeeded) {
        targetWidth = THUMBNAIL_WIDTH;
        targetHeight = THUMBNAIL_HEIGHT;
      }
      else {
        targetWidth = targetPreviewWidth;
        targetHeight = targetPreviewHeight;
      }

      // With the original and target sizes, we compute a sample size factor
      // that we use with the #-moz-samplesize media fragment so that we
      // decode the image at a size close to the target size.
      var samplesize = Math.floor(Math.min(originalWidth / targetWidth,
                                           originalHeight / targetHeight));

      // If we can decode the image at a smaller size add a media fragment
      // to the URL. This might only work for JPEG images, but it shouldn't
      // hurt to do it for all.
      if (samplesize > 1) {
        url += '#-moz-samplesize=' + samplesize;
      }

      console.log('original', originalWidth, originalHeight,
                  'target', targetWidth, targetHeight,
                  'samplesize', samplesize);
    }

    offscreenImage.src = url;

    offscreenImage.onerror = function() {
      URL.revokeObjectURL(url);
      offscreenImage.src = '';
      error('createThumbnailAndPreview: Image failed to load');
    };

    offscreenImage.onload = function() {
      URL.revokeObjectURL(url);

      var iw = offscreenImage.width;
      var ih = offscreenImage.height;
      console.log('image decoded at',
                  offscreenImage.width, offscreenImage.height);

      // If we didn't have a width and height for the image to begin with
      // then we read the image at full size, and now we know the size
      if (!metadata.width || !metadata.height) {
        metadata.width = iw;
        metadata.height = ih;
      }

      // If this is a big image, then decoding it takes a lot of memory.
      // We set this flag to prevent the user from zooming in on other
      // images at the same time because that also takes a lot of memory
      // and we don't want to crash with an OOM. If we find one big image
      // we assume that there may be others, so the flag remains set until
      // the current scan is complete.
      //
      // XXX: When bug 854795 is fixed, we'll be able to create previews
      // for large images without using so much memory, and we can remove
      // this flag then.
      if (iw * ih > 2 * 1024 * 1024 && bigFile)
        bigFile();

      // If the image was already thumbnail size, it is its own thumbnail
      // and it does not need a preview
      if (metadata.width <= THUMBNAIL_WIDTH &&
          metadata.height <= THUMBNAIL_HEIGHT) {
        offscreenImage.src = '';
        metadata.thumbnail = file;
        callback(metadata);
      }
      else {
        createThumbnailFromElement(
          offscreenImage,
          false,
          metadata.rotation || 0,
          metadata.mirrored || false,
          gotThumbnail,
          error);
      }

      function gotThumbnail(thumbnail) {
        metadata.thumbnail = thumbnail;
        // If no preview was requested, or if if the image was less
        // than half a megapixel then it does not need a preview
        // image, and we can call the callback right away
        if (noPreviewNeeded) {
          offscreenImage.src = '';
          callback(metadata);
        }
        else {
          // Otherwise, this was a big image and we need to create a
          // preview for it so we can avoid decoding the full size
          // image again when possible
          createAndSavePreview();
        }
      }

      function createAndSavePreview() {
        // Figure out the preview size.
        // Make sure the size is big enough for both landscape and portrait
        var scale = Math.max(Math.min(sw / iw, sh / ih, 1),
                             Math.min(sh / iw, sw / ih, 1));
        var pw = iw * scale, ph = ih * scale; // preview width and height;

        // Create the preview in a canvas
        var canvas = document.createElement('canvas');
        canvas.width = pw;
        canvas.height = ph;
        var context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(offscreenImage, 0, 0, iw, ih, 0, 0, pw, ph);
        canvas.toBlob(function(blob) {
          offscreenImage.src = '';
          canvas.width = canvas.height = 0;
          savePreview(blob);
        }, 'image/jpeg');

        function savePreview(previewblob) {
          var storage = navigator.getDeviceStorage('pictures');
          var filename;
          if (file.name[0] === '/') {
            // We expect file.name to be a fully qualified name (perhaps
            // something like /sdcard/DCIM/100MZLLA/IMG_0001.jpg).
            var slashIndex = file.name.indexOf('/', 1);
            if (slashIndex < 0) {
              error("savePreview: Bad filename: '" + file.name + "'");
              return;
            }
            filename =
              file.name.substring(0, slashIndex) + // storageName (i.e. /sdcard)
              '/.gallery/previews' +
              file.name.substring(slashIndex); // rest of path (i,e, /DCIM/...)
          } else {
            // On non-composite storage areas (e.g. desktop), file.name will be
            // a relative path.
            filename = '.gallery/previews/' + file.name;
          }

          // Delete any existing preview by this name
          var delreq = storage.delete(filename);
          delreq.onsuccess = delreq.onerror = save;

          function save() {
            var savereq = storage.addNamed(previewblob, filename);
            savereq.onerror = function() {
              console.error('Could not save preview image', filename);
            };

            // Don't actually wait for the save to complete. Go start
            // scanning the next one.
            metadata.preview = {
              filename: filename,
              width: pw,
              height: ph
            };
            callback(metadata);
          }
        }
      }
    };
  }

  function videoMetadataParser(file, metadataCallback, errorCallback) {
    var metadata = {};
    var videofilename = file.name.replace('.jpg', '.3gp');
    metadata.video = videofilename;

    var getreq = videostorage.get(videofilename);
    getreq.onerror = function() {
      errorCallback('cannot get video file: ' + videofilename);
    };
    getreq.onsuccess = function() {
      var videofile = getreq.result;
      getVideoRotation(videofile, function(rotation) {
        if (typeof rotation === 'number') {
          metadata.rotation = rotation;
          getVideoThumbnailAndSize();
        }
        else if (typeof rotation === 'string') {
          errorCallback('Video rotation:', rotation);
        }
      });
    };

    function getVideoThumbnailAndSize() {
      var url = URL.createObjectURL(file);
      offscreenImage.src = url;

      offscreenImage.onerror = function() {
        URL.revokeObjectURL(url);
        offscreenImage.src = '';
        errorCallback('getVideoThumanailAndSize: Image failed to load');
      };

      offscreenImage.onload = function() {
        URL.revokeObjectURL(url);

        // We store the unrotated size of the poster image, which we
        // require to have the same size and rotation as the video
        metadata.width = offscreenImage.width;
        metadata.height = offscreenImage.height;

        createThumbnailFromElement(offscreenImage,
                                   true,
                                   metadata.rotation,
                                   false,
                                   function(thumbnail) {
                                     metadata.thumbnail = thumbnail;
                                     offscreenImage.src = '';
                                     metadataCallback(metadata);
                                   },
                                   errorCallback);
      };
    }
  }

  return metadataParser;
}());
