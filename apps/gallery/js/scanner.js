/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

// XXX
// the persist function is crashing, probably when trying to save
// 500 thumbnails at once. But maybe when writing the index file.
// XXX
// The JSON.parse() on startup is failing, too.

'use strict';

/**
 * Scanner.js: a simple interface to DeviceStorage that serves
 *             as a model of the filesystem and provides easy access to the
 *             user's media files and their metadata.
 */
var Scanner = (function() {

  const INDEX_FILENAME = 'index';
  const THUMBNAIL_DIR = 'thumbs/';
  const THUMBNAIL_EXT = '.t'; // So device storage doesn't think it is an image

  // 
  // name is the app name. We'll add a '.' before and 'DB' after and
  // use that as a directory name for the index file and thumbnails
  // 
  // version is not used now, but allows upgrades in the future
  // 
  // callback is the function that we send all notifications to
  // 
  // media is a data structure that describes what media types we're
  // interested in and how to parse their metadata.
  // 
  function Scanner(name, version, callback, media) {
    console.startup('Scanner() constructor');
    var scanner = this;
    this.directory = '.' + name + '/';
    this.indexfilename = this.directory + INDEX_FILENAME + version;
    this.thumbnaildir = this.directory + THUMBNAIL_DIR;
    this.media = media;
    this.callback = callback;
    this.files = [];  // An array of names of known files. First is newest.
    this.data = {};   // Maps filenames to file data and metadata.
    this.thumbnails = {}; // Maps filenames to cached thumbnail blob urls
    this.state = Scanner.READY;
    this.scanning = 0;
    this.dirty = false;  // Has a scan found changes that need to be persisted?
    this.sdcard = navigator.getDeviceStorage('sdcard');

    this.sdcard.available().onsuccess = function(e) {
      var state = e.target.result;
      switch(state) {
      case 'available':
        init(scanner);
        break;
      case 'unavailable':
        changeState(scanner, Scanner.NOCARD);
        break;
      case 'shared':
        changeState(scanner, Scanner.UNMOUNTED);
        break;
      }
    }

    this.sdcard.onchange = function(e) {
      switch(e.reason) {
      case 'available':
        changeState(scanner, Scanner.READY);
        init(scanner);
        break;
      case 'unavailable':
        changeState(scanner, Scanner.NOCARD);
        endscan(scanner);
        break;
      case 'shared':
        changeState(scanner, Scanner.UNMOUNTED);
        endscan(scanner);
        break;
      }
    }
  }

  // These are the values of the state property of a Scanner object
  // The NOCARD and UNMOUNTED values are also used as the detail
  // property of 'unavailable' callbacks
  Scanner.READY = 'ready';         // Scanner is available and ready for use
  Scanner.NOCARD = 'nocard';       // Unavailable because there is no sd card
  Scanner.UNMOUNTED = 'unmounted'; // Unavailable because card unmounted

  /*
    Init sequence:
    
    The constructor calls init() which reads the flat file db, sets up
    the files array and data object and sends a 'ready' event.

    scan():
     - calls initDeviceStorage if it hasn't already been called
     - marks all files in the files[] array as unverified
     - calls the async function scanOneKind for each kind of device storage

    initDeviceStorage(): synchronously obtains a device storage object
    for each kind of media storage it needs and registers an device
    storage change event handler for each.

    scanOneKind():

      - if we're not already scanning, send a 'scanstart' notification
        and increments the pending scans counter

      - creates a device storage cursor to enumerate one kind of media
        files. If there is at least one known file, it only looks for
        files that are newer. If a directory was specified it only 
        enumerates that directory.
      
      - as files are found, they are passed to the addFile() function

      - when the enumeration is done, scanOneKind() calls verify()

    verify() is called to verify that all of the files in the files[]
    array that are of one particular kind of media and that were in
    the files[] array before the scan started still exist in the
    device storage for that kind of media. If it finds a file that no
    longer exists, it calls removeFile().  When all unverified files
    of that kind have been verified or removed, it calls endscan() to
    decrement the pending scan counter.

    endscan() decrements the pending scan counter and when it reaches
    zero, it knows that the concurrent scan of each of the device
    storage areas is complete.  It sends a 'scanend' notification and
    then calls persist()

    persist(): This function updates the db to match
    the current state of the files[] array. If addFile() and
    removeFile() are called for device storage changes, they write the
    change to the db right away. But when called during a scan, they
    just append to a pendingDBUpdates array. The persist() function
    uses this array.
    
    removeFile(): this function is called when we get a device storage
    notification that a file has been deleted or when the scanning
    process detects that a file has been deleted. It removes the file
    from scanner's files[] array and data object, then sends a
    'delete' notification.  If a scan is in process, it remembers the
    deleted file so the db can be updated when the scan is done. If no
    scan is in process, it starts an async db delete, but returns
    immediately.

    addFile(): this is called when we get a device storage
    notification that a new file has been created or when scanning
    finds a new file.  These are actually quite different cases... ds
    notifications just give us a filename, and we then have to look up
    the actual file in ds. But when scanning, we get the File object
    directly. So this function can be called with a string or a File.
    In the non-scanning case, it asynchronously looks up the File and
    asynchronously saves the new fileinfo record to the db (but
    returns before that transaction completes.)  In the scanning case,
    it doesn't have to look up the file and just queues the fileinfo
    record to be persisted later, so it is much less async in this
    case.  In both cases, however, it has to do asynchronous metadata
    parsing in order to construct the fileinfo record for the file.

   */

  function init(scanner) {
    var getreq = scanner.sdcard.get(scanner.indexfilename);
    getreq.onerror = errorHandler;

    getreq.onsuccess = function() {
      console.startup('got file from device storage');
      var file = getreq.result;
      var thumbnails = [];
      readFileAt(0);

      function readFileAt(offset) {
        if (offset+4 >= file.size) {
          console.warn('Ignoring corrupt index file');
          errorHandler();
          return;
        }
        var slice = file.slice(offset, offset+4);
        var reader = new FileReader();
        reader.readAsArrayBuffer(slice);
        reader.onerror = errorHandler;
        reader.onload = function() {
          var array = new Uint32Array(reader.result);
          var len = array[0]; 
          console.log('index file segment length', len);
          if (len > 0) {
            thumbnails.push(file.slice(offset+4, offset+4+len));
            readFileAt(offset+4+len);
          }
          else {
            var jsonblob = file.slice(offset+4);
            var reader2 = new FileReader();
            reader2.readAsText(jsonblob);
            reader2.onerror = errorHandler;
            reader2.onload = function() {
              var jsontext = reader2.result;
              console.log('json text length:', jsontext.length);
              var filesarray = JSON.parse(jsontext);
              initFromIndexFile(filesarray);
            };
          }
        };
      }

      function initFromIndexFile(files) {
        scanner.files = files;
        for(var i = 0; i < files.length; i++) {
          scanner.data[files[i].name] = files[i];
        }
        for(var i = 0; i < thumbnails.length; i++) {
          scanner.thumbnails[files[i].name] =
            URL.createObjectURL(thumbnails[i]);
        }
        console.startop('parsed index file');
        scanner.callback('ready');
      }
    };
      
    // If we can't find the file (or can't read it for some reason)
    // we just start with no files and do a full scan.
    function errorHandler() {
      console.log("Can't find, or can't read index file",
                  scanner.indexfilename);
      scanner.files = [];
      scanner.data = {};
      scanner.callback('ready');
    }
  };

  function scan(scanner) {
    if (!deviceStorageInitialized)
      initDeviceStorage(scanner);

    console.startup('beginning scan');
    var firstscan = scanner.files.length === 0;
    var timestamp = firstscan ? 0 : scanner.files[0].date;

    // Start by marking all known files as unverified until we go back
    // through and ensure that they still exist
    for(var i = 0; i < scanner.files.length; i++) 
      scanner.files[i].unverified = true;

    for(var kind in scanner.media) {
      scanOneKind(kind);
    }

    function scanOneKind(kind) {
      var storage = scanner.media[kind].storage;
      var directory = scanner.media[kind].directory || '';

      scanner.scanning++;
      if (scanner.scanning === 1) { // if we weren't already scanning
        scanner.callback('scanstart');
      }
      
      var cursor;
      if (timestamp > 0) {
        cursor = storage.enumerate(directory, {
          // add 1 so we don't find the same newest file again
          since: new Date(timestamp + 1)
        });
      }
      else {
        cursor = storage.enumerate(directory);
      }

      cursor.onerror = function() {
        // We can't scan if we can't read device storage.
        // Perhaps the card was unmounted or pulled out
        console.warning('Error while scanning', cursor.error);
        endscan(scanner);
      };

      cursor.onsuccess = function() {
        var file = cursor.result;

        if (file) {
          if (file.name.indexOf('thumbnails/') !== -1)
            console.log(file.name);
          
          if (ignore(scanner, kind, file)) {
            cursor.continue();
          }
          else {
            addFile(scanner, kind, file, function() { cursor.continue(); });
          }
        }
        else {
          // We're done scanning for new files. Now we have to verify
          // that all of the existing files still exist.
          verify(kind, storage) 
        }
      }
    }

    // Loop through the files that are unverified and of this kind
    // and verify that they still exist in the specified device storage
    function verify(kind, storage) {
      console.startup('Starting verify for ' + kind);
      verifyNextFile(0);
      function verifyNextFile(n) {
        while(n < scanner.files.length) {
          var f = scanner.files[n];

          if (f.unverified && f.kind === kind) {
            // We found a file that needs to be verified. Go see if
            // it exists in device storage.
            var get = storage.get(f.name);
            get.onsuccess = function() {
              // If we got a file, then verify f.
              delete f.unverified;
              // If the file is different than we expect, delete and recreate
              var g = get.result;
              if (f.size !== g.size || 
                  (g.lastModifiedDate &&
                   g.lastModifiedDate.getTime() !== f.date)) {
                removeFile(scanner, f.name);
                addFile(scanner, kind, g)
              }
              verifyNextFile(n+1);
            };
            get.onerror = function() {
              // If the file does not exist, we just delete it
              removeFile(scanner, f.name);
              verifyNextFile(n+1);
            };

            // Don't continue looping now. When the verification is done
            // the loop will be restarted
            return;
          }
            
          n++;
        }
        
        // When we exit the loop, we're done with scanning for this storage
        console.startup('Ending verify for ' + kind);
        endscan(scanner);
      }
    }
  }

  // Called to send out a scanend event when scanning is done.
  // This event is sent on normal scan termination and also
  // when something goes wrong, such as the device storage being
  // unmounted during a scan.  Note that we call scan() once to 
  // scan all of the device storages we care about. But each of those
  // scans must call endscan() before scanning actually ends.
  function endscan(scanner) {
    if (scanner.scanning) {
      scanner.scanning--;
      if (scanner.scanning === 0) {  // If the last scan is done
        scanner.callback('scanend');
        console.startup('Done scanning');
        persist(scanner);
      }
    }
  }



  var deviceStorageInitialized = false;

  function initDeviceStorage(scanner) {
    for(var kind in scanner.media) {
      var options = scanner.media[kind];
      scanner.media[kind].storage =
        initStorage(kind, options.directory, options.mimeTypes);
    }
    deviceStorageInitialized = true;

    function initStorage(kind, directory, mimeTypes) {
      var storage = navigator.getDeviceStorage(kind);
      storage.addEventListener('change', deviceStorageChangeHandler);
      return storage;

      function deviceStorageChangeHandler(e) {
        switch (e.reason) {
        case 'modified':
        case 'deleted':
          var filename = e.path;
          if (ignoreName(filename))
            break;
          if (directory) {
            // Ignore changes outside of our directory
            if (filename.substring(0, directory.length) !== directory)
              break;
          }
          if (e.reason === 'modified')
            addFileByName(scanner, kind, filename);
          else
            removeFile(scanner, filename);
          break;
        }
      }
    }
  }

  function addFileByName(scanner, kind, filename) {
    var storage = scanner.media[kind].storage;
    storage.get(filename).onsuccess = function(e) {
      var file = e.target.result;
      addFile(scanner, kind, file, function() {
        // If the file was created while a scan is in process we don't
        // have to persist now because that will happen when the scan ends.
        if (!scanner.scanning)
          persist(scanner);
      });
    };
  }

  // This updates the scanner state in memory and notifies the client.
  // This function should be useful for change events and scan results.
  function addFile(scanner, kind, file, callback) {
    var filename = file.name;

    // If we already know about this file, then first delete the known file
    if (scanner.data[filename]) {
      removeFile(scanner, filename);
    }

    if (ignore(scanner, kind, file)) {
      if (callback)
        callback();
      return;
    }

    var fileinfo = {
      name: file.name,
      kind: kind,
      type: file.type,
      size: file.size,
      date: file.lastModifiedDate.getTime()
    };

    var metadataParser = scanner.media[kind].metadataParser;
    metadataParser(file, metadataSuccess, metadataError);

    function metadataError(msg) {
      // If metadata parsing fails, ignore the file. Don't put it in 
      // our files[] array, don't save it to the db, and don't notify
      // the client app about it. As long as there is a newer file with
      // good metadata, we'll never scan the broken file again.
      console.warn('MediaDB: error parsing metadata for', filename, ':', msg);
      if (callback)
        callback();
    }

    function metadataSuccess(metadata) {
      if (metadata.thumbnail) {
        // For newly found images and videos, we just use the
        // in-memory blob.  (At 10k each, even 1000 of them only take
        // 10mb of memory.) We'll save these to disk when we call persist()
        // but we don't slow down scanning by saving them now.
        fileinfo.metadata = metadata;
        scanner.data[filename] = fileinfo;
        var pos = insertNewFile(scanner, fileinfo);
        scanner.dirty = true;
        scanner.callback('insert', fileinfo, pos);

        if (scanner.files.length === 12)
          console.startup('scanned 12th file');
      }

      if (callback)
        callback();
    }
  }

  // This updates the scanner state in memory and notifies the client.
  // It then updates the database, or, if we're scanning, queues the update.
  // This function should be useful for change events and scan results.
  function removeFile(scanner, filename) {
    var fileinfo = scanner.data[filename];

    // If we don't already know about this file, ignore it
    if (!fileinfo)
      return;

    var pos = scanner.files.indexOf(fileinfo);
    if (pos === -1)  // this should not happen
      return;

    // Remove it from the data object
    delete scanner.data[filename];

    // Remove it from the files array
    scanner.files.splice(pos, 1);

    // Notify the app that it has been deleted
    scanner.callback('delete', fileinfo, pos);

    // Release the thumbnail URL
    if (scanner.thumbnails[filename])
      URL.revokeObjectURL(scanner.thumbnails[filename]);

    // Delete the thumbnail file, if one exists
    scanner.sdcard.delete(scanner.thumbnaildir + filename + THUMBNAIL_EXT);

    // This is a change that needs to be saved
    scanner.dirty = true;

    // If we're not scanning, save it now
    if (!scanner.scanning)
      persist(scanner);
  }

  // Insert a new fileinfo object into the scanner.files array
  // But insert it so that it the array remains sorted by date with
  // newest files first.  Return the position at which it was inserted
  function insertNewFile(scanner, fileinfo) {
    var pos;
    // If this new file is newer than the first one, it goes first.
    // This is a common special case
    if (scanner.files.length === 0 || fileinfo.date > scanner.files[0].date) {
      pos = 0;
    }
    else {
      // Otherwise we have to search for the right insertion spot
      pos = binarysearch(scanner.files, fileinfo, compareFileInfoByDate);
    }

    scanner.files.splice(pos, 0, fileinfo);
    return pos;
  }

  // This comparison function is used for sorting arrays and doing binary
  // search on the resulting sorted arrays.
  function compareFileInfoByDate(a, b) { return b.date - a.date; }

  // Assuming that array is sorted according to comparator, return the
  // array index at which element should be inserted to maintain sort order
  function binarysearch(array, element, comparator, from, to) {
    if (from === undefined)
      return binarysearch(array, element, comparator, 0, array.length);

    if (from === to)
      return from;

    var mid = Math.floor((from + to) / 2);

    var result = comparator(element, array[mid]);
    if (result < 0)
      return binarysearch(array, element, comparator, from, mid);
    else
      return binarysearch(array, element, comparator, mid + 1, to);
  }

  //
  // Return true if scanner should ignore this file.
  //
  // If any components of the path begin with a . we'll ignore the file.
  // The '.' prefix indicates hidden files and directories on Unix and
  // when files are "moved to trash" during a USB Mass Storage session they
  // are sometimes not actually deleted, but moved to a hidden directory.
  //
  // If an array of media types was specified when the Scanner was created
  // and the type of this file is not a member of that list, then ignore it.
  //
  function ignore(scanner, kind, file) {
    if (ignoreName(file.name))
      return true;
    var types = scanner.media[kind].mimeTypes;
    if (types && types.indexOf(file.type) === -1)
      return true;
    return false;
  }

  // Test whether this filename is one we ignore.
  // This is a separate function because device storage change events
  // give us a name only, not the file object.
  function ignoreName(filename) {
    return (filename[0] === '.' || filename.indexOf('/.') !== -1);
  }

  function persist(scanner) {
    // Don't do anything here unless the scan process found at least one change
    if (!scanner.dirty)
      return;

    console.startup('Starting to save to file');

    // Fetch thumbnail image blobs for the first page of thumbnails
    var filenames = [];
    var blobs = [];
    var numblobs = Math.min(scanner.files.length, PAGE_SIZE);

    // The filenames of the first page
    for(var i = 0; i < numblobs; i++) 
      filenames[i] = scanner.files[i].name;

    // Fetch the first page of thumbnails, then save all new thumbnails
    // then save the index file
    fetchThumbnails(function() {
      console.startup('Save thumbnails');
      saveThumbnails(0, saveIndexFile);
    });

    function fetchThumbnails(next) {
      console.startup('Fetch thumbnails');
      var numfetched = 0;
      // Get the thumbnail blob for each of those first files
      filenames.forEach(function(filename, index) {
        getThumbnailBlob(scanner, filename, function(blob) {
          blobs[index] = blob;
          if (++numfetched === numblobs)
            next();
        });
      });
    }

    // Find the first file at or after index n that has a thumbnail that
    // needs to be saved. If one is found, save it, then call this function
    // again wiht an index one higher than the one saved.  If no thumbnail
    // needs to be saved, call the next() function.
    function saveThumbnails(n, next) {
      for(var i = n; i < scanner.files.length; i++) {
        var fileinfo = scanner.files[i];
        if (fileinfo.metadata.thumbnail) {

          var filename = scanner.thumbnaildir + fileinfo.name + THUMBNAIL_EXT;
          scanner.sdcard.delete(filename);
          var savereq = scanner.sdcard.addNamed(fileinfo.metadata.thumbnail,
                                                filename);
          savereq.onerror = function() {
            console.error(savereq.error.name,
                          'Failed to save thumbnail in file', filename);
            saveThumbnails(i+1, next);
          };

          savereq.onsuccess = function() {
            // Now that the blob is saved, don't hold on to it any longer.
            // If we haven't already created and cached a blob: url for it
            // this will free the memory.
            delete fileinfo.metadata.thumbnail;
            saveThumbnails(i+1, next);
          };
          
          return;
        }
      }
      next();
    }

    function saveIndexFile() {
      console.startup('saveIndexFile');
      // These are the items we're building our blob from
      var items = [];
      // For each blob, push on the length, then the blob
      for(var i = 0; i < numblobs; i++) {
        var len = new Uint32Array(1);
        len[0] = blobs[i].size;
        items.push(len);
        items.push(blobs[i]);
      }

      // Finally, add the files array
      var len = new Uint32Array(1);
      len[0] = 0; // A length of zero means the next item is not a blob 
      items.push(len);
      items.push(JSON.stringify(scanner.files));

      // This is the new index file.
      var blob = new Blob(items);

      console.log("thumbnails:", blobs.length);
      console.log("items:", items.length);
      console.log("blob size", blob.size);
      console.log("filename", scanner.indexfilename);

      // First, delete the old file.
      var delreq = scanner.sdcard.delete(scanner.indexfilename);
      delreq.onerror = delreq.onsuccess = function() {
        // When the delete has failed or succeeded we know we
        // can save the blob
        var savereq = scanner.sdcard.addNamed(blob, scanner.indexfilename);
        savereq.onsuccess = function(e) {
          console.startup('Data persisted to file');
        };
        savereq.onerror = function(e) {
          console.error('Failed to save to file',
                        e.target.error, e.target.error.name);
        };
      };
    }
  }

  function changeState(scanner, state) {
    if (scanner.state !== state) {
      scanner.state = state;
      if (state === Scanner.READY)
        scanner.callback('ready');
      else
        scanner.callback('unavailable', state);
    }
  }

  function getThumbnailBlob(scanner, filename, callback) {
    var fileinfo = scanner.data[filename];
    if (fileinfo.metadata.thumbnail) {
      callback(fileinfo.metadata.thumbnail);
      return;
    }

    var thumbfilename = scanner.thumbnaildir + filename + THUMBNAIL_EXT;
    var getreq = scanner.sdcard.get(thumbfilename);
    getreq.onerror = function() {
      console.error(getreq.error.name,
                    'Couldn\'t get thumbnail file', thumbfilename);
      // XXX:
      // should I go back to the metadata parser and try to 
      // recreate the file when this happens?  Or do we just let
      // the app break if thumbnails are accidentally deleted?
      callback(null);
    };
    getreq.onsuccess = function() {
      callback(getreq.result);
    }
  }

  Scanner.prototype = {
    scan: function() {
      scan(this);
    },

    // Look up the specified filename in DeviceStorage and pass the
    // resulting File object to the specified callback.
    getFile: function getFile(filename, callback, errback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var fileinfo = this.data[filename];
      if (!fileinfo)
        throw Error('Scanner: unknown file: ' + filename);

      var kind = fileinfo.kind;
      var storage = this.media[kind].storage;

      var getRequest = storage.get(filename);
      getRequest.onsuccess = function() {
        callback(getRequest.result);
      };
      getRequest.onerror = function() {
        var errmsg = getRequest.error && getRequest.error.name;
        if (errback)
          errback(errmsg);
        else
          console.error('Scanner.getFile:', errmsg);
      }
    },

    getThumbnailURL: function getThumbnailURL(filename, callback) {
      var url = this.thumbnails[filename];
      if (url) {
        callback(url);
        return;
      }

      getThumbnailBlob(scanner, filename, function(blob) {
        if (blob === null) {
          callback(null)
        }
        else {
          var url = URL.createObjectURL(blob);
          scanner.thumbnails[filename] = url;
          callback(url);
        }
      });
    },
    
    // Delete the named file from device storage.
    // This will cause a device storage change event, which will cause
    // Scanner to remove the file from the database and send out a
    // Scanner change event, which will notify the application UI.
    deleteFile: function deleteFile(filename) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var fileinfo = this.data[filename];
      if (!fileinfo) {
        console.warning('deleteFile: unknown file', filename);
        return;
      }
      var storage = this.media[fileinfo.kind].storage;

      storage.delete(filename).onerror = function(e) {
        console.error('Scanner.deleteFile(): Failed to delete', filename,
                      'from DeviceStorage:', e.target.error);
      };
    },

    //
    // Save the specified blob to device storage, using the specified filename.
    // This will cause device storage to send us an event, and that event
    // will cause Scanner to add the file to its database, and that will
    // send out a Scanner event to the application UI.
    //
    addFile: function addFile(kind, filename, file) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var storage = this.media[kind].storage;
      var scanner = this;

      // Delete any existing file by this name, then save the file.
      var deletereq = storage.delete(filename);
      deletereq.onsuccess = deletereq.onerror = save;

      function save() {
        var request = storage.addNamed(file, filename);
        request.onerror = function() {
          console.error('Scanner: Failed to store', filename,
                        'in DeviceStorage:', storeRequest.error);
        };
      }
    },

    // Use the device storage freeSpace() method and pass the returned
    // value to the callback.
    freeSpace: function freeSpace(callback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      this.sdcard.freeSpace().onsuccess = function(e) {
        callback(e.target.result);
      };
    }
  };

  return Scanner;
}());
