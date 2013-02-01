/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

/**
 * Scanner.js: a simple interface to DeviceStorage and IndexedDB that serves
 *             as a model of the filesystem and provides easy access to the
 *             user's media files and their metadata.
 */
var Scanner = (function() {

  function Scanner(name, version, media) {
    this.dbname = 'Scanner-' + name;
    this.version = version;
    this.media = media;
    this.files = [];  // An array of names of known files. First is newest.
    this.data = {};   // Maps filenames to file data and metadata.
    this.callback = null;
    this.state = Scanner.READY;
    this.scanning = 0;
    initDB(scanner);
  }

  // This is the version number of the Scanner schema. If we change this
  // number it will cause existing data stores to be deleted and rebuilt,
  // which is useful when the schema changes. Note that the user can also
  // upgrade the version number with an option to the Scanner constructor.
  // The final indexedDB version number we use is the product of our version
  // and the user's version.
  Scanner.VERSION = 1;

  // These are the values of the state property of a Scanner object
  // The NOCARD and UNMOUNTED values are also used as the detail
  // property of 'unavailable' callbacks
  Scanner.READY = 'ready';         // Scanner is available and ready for use
  Scanner.NOCARD = 'nocard';       // Unavailable because there is no sd card
  Scanner.UNMOUNTED = 'unmounted'; // Unavailable because card unmounted

  function initDB(scanner) {
    // Open the database
    // Note that the user can upgrade the version and we can upgrade the version
    var openRequest = indexedDB.open(this.dbname,
                                     this.version * Scanner.VERSION);

    // This should never happen for Gaia apps
    openRequest.onerror = function(e) {
      console.error('Scanner():', openRequest.error.name);
    };

    // This should never happen for Gaia apps
    openRequest.onblocked = function(e) {
      console.error('indexedDB.open() is blocked in Scanner()');
    };

    // This is where we create (or delete and recreate) the database
    openRequest.onupgradeneeded = function(e) {
      var db = openRequest.result;

      // If there are already existing object stores, delete them all
      // If the version number changes we just want to start over.
      var existingStoreNames = db.objectStoreNames;
      for (var i = 0; i < existingStoreNames.length; i++) {
        db.deleteObjectStore(existingStoreNames[i]);
      }

      // Now build the database
      var filestore = db.createObjectStore('files', { keyPath: 'name' });
      // Always index the files by modification date so we can enumerate
      // them in the order we want them.
      filestore.createIndex('date', 'date');
    }

    // This is called when we've got the database open and ready.
    openRequest.onsuccess = function(e) {
      scanner.db = openRequest.result;

      // Log any errors that propagate up to here
      scanner.db.onerror = function(event) {
        console.error('Scanner: ',
                      event.target.error && event.target.error.name);
      }

      // Now start enumerating the files we already know about
      enumerateDB(scanner);
    };
  }

  // This function initializes the files array with data from the database.
  // If there is a callback, it calls it.
  // When the enumeration is complete, it starts a scan.
  // XXX
  // For now, this just uses a cursor.  If that is not fast enough,
  // I'll change it to use mozGetAll() for an initial batch and then for
  // all the rest of the entries in another big batch. 
  // With mozGetAll, though, I'll have to create an index on the negative
  // of the file mod time so they're in the right order.
  function enumerateDB(scanner) {
    var request = this.db.transaction('files')
      .objectStore('files')
      .index('date')
      .openCursor(null, 'prev');

    request.onerror = function() {
      console.error('Scanner: cursor request filed with', request.error);
    }

    request.onsuccess = function() {
      var cursor = request.result;
      if (cursor) {
        fileinfo = cursor.value;
        fileinfo.persisted = true; // we know it is in the db
        files.push(fileinfo);
        data[fileinfo.name] = fileinfo;
        if (scanner.callback && !fileinfo.fail)
          scanner.callback('append', fileinfo);
      }
      else {
        initDeviceStorage(scanner);
      }
    }
  }

  function initDeviceStorage(scanner) {

    // If there is more than one device storage object we're going to use
    // we only want available/unavailable events from one of them, so 
    // only pass true to the first init.
    var first = true;

    for(var kind in scanner.media) {
      var options = scanner.media[kind];
      scanner.media[kind].storage =
        initStorage(kind, options.directory, options.mimeTypes, first);
      first = false;
    }

    scan(scanner);

    function initStorage(kind, directory, mimeTypes, monitor_card_state) {
      var storage = navigator.getDeviceStorage(kind);
      storage.addEventListener('change', deviceStorageChangeHandler);
      if (monitor_card_state)
        checkAvailability(storage);
      return storage;

      function deviceStorageChangeHandler(e) {
        var filename;
        switch (e.reason) {
        case 'available':
          if (monitor_card_state) {
            changeState(scanner, Scanner.READY);
            scan(scanner); // automatically scan every time the card comes back
          }
          break;
        case 'unavailable':
          if (monitor_card_state) {
            changeState(scanner, Scanner.NOCARD);
          }
          endscan(scanner);
          break;
        case 'shared':
          if (monitor_card_state) {
            changeState(scanner, Scanner.UNMOUNTED);
          }
          endscan(scanner);
          break;
        case 'modified':
        case 'deleted':
          filename = e.path;
          if (ignoreName(filename))
            break;
          if (directory) {
            // Ignore changes outside of our directory
            if (filename.substring(0, directory.length) !== directory)
              break;
          }
          if (e.reason === 'modified')
            addFile(scanner, kind, filename);
          else
            removeFile(scanner, filename);
          break;
        }
      }

      function checkAvailability(storage) {
        // Use available() to figure out if there is actually an sdcard there.
        // If the storage is availble, do nothing, otherwise notify
        var availreq = storage.available();
        availreq.onsuccess = function(e) {
          switch (e.target.result) {
          case 'unavailable':
            changeState(scanner, Scanner.NOCARD);
            break;
          case 'shared':
            changeState(scanner, Scanner.UNMOUNTED);
            break;
          }
        };
      }
    }
  }

  // This updates the scanner state in memory and notifies the client.
  // It then updates the database, or, if we're scanning, queues the update.
  // This function should be useful for change events and scan results.
  function addFile(scanner, kind, fileOrName) {
    var file, filename;
    if (typeof fileOrName === 'string') {
      filename = fileOrName;
      file = null;
    }
    else {
      file = fileOrName
      filename = file.name;
    }

    // If we already know about this file, then first delete the known file
    if (scanner.data[filename]) {
      removeFile(scanner, filename);
    }

    var storage = scanner.media[kind].storage;
    if (file) {
      add(file)
    }
    else {
      storage.get(filename).onsuccess = function(e) {
        add(e.target.result);
      };
    }

    function add(file) {
      if (ignore(scanner, file))
        return;
      var fileinfo = {
        name: file.name,
        type: file.type,
        size: file.size,
        date: file.lastModifiedDate ?
          file.lastModifiedDate.getTime() :
          Date.now()
        kind: kind
      };

      // XXX: parse metadata here before we do more
      // Does that need to be serialized (through a worker)?
      // The code should work if completely parallel, but I wonder
      // if memory usage would spike if I tried to do lots at once.
      // (especially the image decoding).


      // XXX: 
      // Once metadata parsing is done we may have files that fail it.
      // If a file has the .fail property, then we don't want it in the
      // files[] array.  But we still want it in the data object so we
      // know it exists?
      // XXX: actually, maybe not. With the new scan new/verify old 
      // scanning system, a file that fails will not be rescanned unless
      // there are no newer files.  So maybe we can just ignore failures
      // and get rid of that special case.
      // 
      scanner.data[filename] = fileinfo;
      var pos = insertNewFile(scanner, fileinfo);
      notify(scanner, 'insert', fileinfo, pos);

      if (scanner.scanning) {
        scanner.pendingDBUpdates.push(fileinfo);
      }
      else {
        var txn = scanner.db.transaction('files', 'readwrite');
        txn.objectStore('files').add(fileinfo);
        txn.oncomplete = function() {
          fileinfo.persisted = true; // It has been written 
        };
      }
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
    if (pos !== -1) {
      scanner.files.splice(pos, 1);
      notify(scanner, 'delete', fileinfo, pos);

      if (scanner.scanning) {
        scanner.pendingDBUpdates.push(filename);
      }
      else {
        // If this file was deleted before it was saved to the db, we
        // don't have to delete it now.
        if (fileinfo.persisted) {
          scanner.db.transaction('files', 'readwrite')
            .objectStore('files')
            .delete(filename);
        }
      }
    }
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
  function compareFileInfoByDate(a, b) {
    return b.date - a.date;
  }

  // Assuming that array is sorted according to comparator, return the
  // array index at which element should be inserted to maintain sort order
  function binarysearch(array, element, comparator, from, to) {
    if (comparator === undefined)
      comparator = function(a, b) {
        if (a < b)
          return -1;
        if (a > b)
          return 1;
        return 0;
      };

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
  // Return true if media db should ignore this file.
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

  function scan(scanner) {
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
      var types = scanner.media[kind].mimeTypes || null;

      scanner.scanning++;
      if (scanner.scanning === 1) { // if we weren't already scanning
        notify(scanner, 'scanstart');
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
          if (!ignore(scanner, kind, file))
            addFile(scanner, kind, file);
          cursor.continue();
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
            return
          }
            
          n++;
        }
        
        // When we exit the loop, we're done with scanning for this storage
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
        notify(scanner, 'scanend');
        // XXX: If we found any new or deleted files, persist them now.
        // XXX: should we send the event before that? I think so.
      }
    }
  }


  Scanner.prototype = {
    close: function close() {
      // Close the database
      this.db.close();

      // There is no way to close device storage, but we at least want
      // to stop receiving events from it.
      this.storage.removeEventListener('change', this.details.dsEventListener);

      // Change state and send out an event
      changeState(this, Scanner.CLOSED);
    },

    addEventListener: function addEventListener(type, listener) {
      if (!this.details.eventListeners.hasOwnProperty(type))
        this.details.eventListeners[type] = [];
      var listeners = this.details.eventListeners[type];
      if (listeners.indexOf(listener) !== -1)
        return;
      listeners.push(listener);
    },

    removeEventListener: function removeEventListener(type, listener) {
      if (!this.details.eventListeners.hasOwnProperty(type))
        return;
      var listeners = this.details.eventListeners[type];
      var position = listeners.indexOf(listener);
      if (position === -1)
        return;
      listeners.splice(position, 1);
    },

    // Look up the specified filename in DeviceStorage and pass the
    // resulting File object to the specified callback.
    getFile: function getFile(filename, callback, errback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var getRequest = this.storage.get(this.directory + filename);
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

    // Delete the named file from device storage.
    // This will cause a device storage change event, which will cause
    // Scanner to remove the file from the database and send out a
    // Scanner change event, which will notify the application UI.
    deleteFile: function deleteFile(filename) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      this.storage.delete(this.directory + filename).onerror = function(e) {
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
    addFile: function addFile(filename, file) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var scanner = this;

      // Delete any existing file by this name, then save the file.
      var deletereq = scanner.storage.delete(scanner.directory + filename);
      deletereq.onsuccess = deletereq.onerror = save;

      function save() {
        var request = scanner.storage.addNamed(file, scanner.directory + filename);
        request.onerror = function() {
          console.error('Scanner: Failed to store', filename,
                        'in DeviceStorage:', storeRequest.error);
        };
      }
    },

    // Look up the database record for the named file, and copy the properties
    // of the metadata object into the file's metadata, and then write the
    // updated record back to the database. The third argument is optional. If
    // you pass a function, it will be called when the metadata is written.
    updateMetadata: function(filename, metadata, callback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var scanner = this;

      // First, look up the fileinfo record in the db
      var read = scanner.db.transaction('files', 'readonly')
        .objectStore('files')
        .get(filename);

      read.onerror = function() {
        console.error('Scanner.updateMetadata called with unknown filename');
      };

      read.onsuccess = function() {
        var fileinfo = read.result;

        // Update the fileinfo metadata
        Object.keys(metadata).forEach(function(key) {
          fileinfo.metadata[key] = metadata[key];
        });

        // And write it back into the database.
        var write = scanner.db.transaction('files', 'readwrite')
          .objectStore('files')
          .put(fileinfo);

        write.onerror = function() {
          console.error('Scanner.updateMetadata: database write failed',
                        write.error && write.error.name);
        };

        if (callback) {
          write.onsuccess = function() {
            callback();
          }
        }
      }
    },

    // Count the number of records in the database and pass that number to the
    // specified callback. key is 'name', 'date' or one of the index names
    // passed to the constructor. range is be an IDBKeyRange that defines a
    // the range of key values to count.  key and range are optional
    // arguments.  If one argument is passed, it is the callback. If two
    // arguments are passed, they are assumed to be the range and callback.
    count: function(key, range, callback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      // range is an optional argument
      if (arguments.length === 1) {
        callback = key;
        range = undefined;
        key = undefined;
      }
      else if (arguments.length === 2) {
        callback = range;
        range = key;
        key = undefined;
      }

      var store = this.db.transaction('files').objectStore('files');
      if (key && key !== 'name')
        store = store.index(key);

      var countRequest = store.count(range || null);

      countRequest.onerror = function() {
        console.error('Scanner.count() failed with', countRequest.error);
      };

      countRequest.onsuccess = function(e) {
        callback(e.target.result);
      };
    },


    // Enumerate all files in the filesystem, sorting by the specified
    // property (which must be one of the indexes, or null for the filename).
    // Direction is ascending or descending. Use whatever string
    // constant IndexedDB uses.  f is the function to pass each record to.
    //
    // Each record is an object like this:
    //
    // {
    //    // The basic fields are all from the File object
    //    name: // the filename
    //    type: // the file type
    //    size: // the file size
    //    date: // file mod time
    //    metadata: // whatever object the metadata parser returns
    // }
    //
    // This method returns an object that you can pass to cancelEnumeration()
    // to cancel an enumeration in progress. You can use the state property
    // of the returned object to find out the state of the enumeration. It
    // should be one of the strings 'enumerating', 'complete', 'cancelling'
    // 'cancelled', or 'error'
    //
    enumerate: function enumerate(key, range, direction, callback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var handle = { state: 'enumerating' };

      // The first three arguments are optional, but the callback
      // is required, and we don't want to have to pass three nulls
      if (arguments.length === 1) {
        callback = key;
        key = undefined;
      }
      else if (arguments.length === 2) {
        callback = range;
        range = undefined;
      }
      else if (arguments.length === 3) {
        callback = direction;
        direction = undefined;
      }

      var store = this.db.transaction('files').objectStore('files');

      // If a key other than "name" is specified, then use the index for that
      // key instead of the store.
      if (key && key !== 'name')
        store = store.index(key);

      // Now create a cursor for the store or index.
      var cursorRequest = store.openCursor(range || null, direction || 'next');

      cursorRequest.onerror = function() {
        console.error('Scanner.enumerate() failed with', cursorRequest.error);
        handle.state = 'error';
      };

      cursorRequest.onsuccess = function() {
        // If the enumeration has been cancelled, return without
        // calling the callback and without calling cursor.continue();
        if (handle.state === 'cancelling') {
          handle.state = 'cancelled';
          return;
        }

        var cursor = cursorRequest.result;
        if (cursor) {
          try {
            if (!cursor.value.fail)   // if metadata parsing succeeded
              callback(cursor.value);
          }
          catch (e) {
            console.warn('Scanner.enumerate(): callback threw', e);
          }
          cursor.continue();
        }
        else {
          // Final time, tell the callback that there are no more.
          handle.state = 'complete';
          callback(null);
        }
      };

      return handle;
    },

    // This method takes the same arguments as enumerate(), but batches
    // the results into an array and passes them to the callback all at
    // once when the enumeration is complete. It uses enumerate() so it
    // is no faster than that method, but may be more convenient.
    enumerateAll: function enumerateAll(key, range, direction, callback) {
      var batch = [];

      // The first three arguments are optional, but the callback
      // is required, and we don't want to have to pass three nulls
      if (arguments.length === 1) {
        callback = key;
        key = undefined;
      }
      else if (arguments.length === 2) {
        callback = range;
        range = undefined;
      }
      else if (arguments.length === 3) {
        callback = direction;
        direction = undefined;
      }

      return this.enumerate(key, range, direction, function(fileinfo) {
        if (fileinfo !== null)
          batch.push(fileinfo);
        else
          callback(batch);
      });
    },

    // Cancel a pending enumeration. After calling this the callback for
    // the specified enumeration will not be invoked again.
    cancelEnumeration: function cancelEnumeration(handle) {
      if (handle.state === 'enumerating')
        handle.state = 'cancelling';
    },

    // Use the non-standard mozGetAll() function to return all of the
    // records in the database in one big batch. The records will be
    // sorted by filename
    getAll: function getAll(callback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var store = this.db.transaction('files').objectStore('files');
      var request = store.mozGetAll();
      request.onerror = function() {
        console.error('Scanner.getAll() failed with', request.error);
      };
      request.onsuccess = function() {
        var all = request.result;  // All records in the object store

        // Filter out files that failed metadata parsing
        var good = all.filter(function(fileinfo) { return !fileinfo.fail; });

        callback(good);
      };
    },

    // Scan for new or deleted files.
    // This is only necessary if you have explicitly disabled automatic
    // scanning by setting autoscan:false in the options object.
    scan: function() {
      scan(this);
    },

    // Use the device storage freeSpace() method and pass the returned
    // value to the callback.
    freeSpace: function freeSpace(callback) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var freereq = this.storage.freeSpace();
      freereq.onsuccess = function() {
        callback(freereq.result);
      }
    }
  };



  /* Details of helper functions follow */


  // Tell the db to start a manual scan. I think we don't do
  // this automatically from the constructor, but most apps will start
  // a scan right after calling the constructor and then will proceed to
  // enumerate what is already in the db. If scan performance is bad
  // for large media collections, apps can just have the user specify
  // when to rescan rather than doing it automatically. Until we have
  // change event notifications, gaia apps might want to do a scan
  // every time they are made visible.
  //
  // Filesystem changes discovered by a scan are generally
  // batched. If a scan discovers 10 new files, the information
  // about those files will generally be passed as an array to a the
  // onchange handler rather than calling that handler once for each
  // newly discovered file.  Apps can decide whether to handle
  // batches by processing each element individually or by just starting
  // fresh with a new call to enumerate().
  //
  // Scan details are not tightly specified, but the goal is to be
  // as efficient as possible.  We'll try to do a quick date-based
  // scan to look for new files and report those first. Following
  // that, a full scan will be compared with a full dump of the DB
  // to see if any files have been deleted.
  //
  function scan(scanner) {
    scanner.scanning = true;
    notify(scanner, 'scanstart');

    // First, scan for new files since the last scan, if there was one
    // When the quickScan is done it will begin a full scan.  If we don't
    // have a last scan date, then the database is empty and we don't
    // have to do a full scan, since there will be no changes or deletions.
    quickScan(scanner.details.newestFileModTime);

    // Do a quick scan and then follow with a full scan
    function quickScan(timestamp) {
      var cursor;
      if (timestamp > 0) {
        scanner.details.firstscan = false;
        cursor = scanner.storage.enumerate(scanner.directory, {
          // add 1 so we don't find the same newest file again
          since: new Date(timestamp + 1)
        });
      }
      else {
        // If there is no timestamp then this is the first time we've
        // scanned and we don't have any files in the database, which
        // allows important optimizations during the scanning process
        scanner.details.firstscan = true;
        scanner.details.records = [];
        cursor = scanner.storage.enumerate(scanner.directory);
      }

      cursor.onsuccess = function() {
        var file = cursor.result;
        if (file) {
          if (!ignore(scanner, file))
            insertRecord(scanner, file);
          cursor.continue();
        }
        else {
          // Quick scan is done. When the queue is empty, force out
          // any batched created events and move on to the slower
          // more thorough full scan.
          whenDoneProcessing(scanner, function() {
            sendNotifications(scanner);
            if (scanner.details.firstscan) {
              // If this was the first scan, then we're done
              endscan(scanner);
            }
            else {
              // If this was not the first scan, then we need to go
              // ensure that all of the old files we know about are still there
              fullScan();
            }
          });
        }
      };

      cursor.onerror = function() {
        // We can't scan if we can't read device storage.
        // Perhaps the card was unmounted or pulled out
        console.warning('Error while scanning', cursor.error);
        endscan(scanner);
      };
    }

    // Get a complete list of files from DeviceStorage
    // Get a complete list of files from IndexedDB.
    // Sort them both (the indexedDB list will already be sorted)
    // Step through the lists noting deleted files and created files.
    // Pay attention to files whose size or date has changed and
    // treat those as deletions followed by insertions.
    // Sync up the database while stepping through the lists.
    function fullScan() {
      if (scanner.state !== Scanner.READY) {
        endscan(scanner);
        return;
      }

      // The db may be busy right about now, processing files that
      // were found during the quick scan.  So we'll start off by
      // enumerating all files in device storage
      var dsfiles = [];
      var cursor = scanner.storage.enumerate(scanner.directory);
      cursor.onsuccess = function() {
        var file = cursor.result;
        if (file) {
          if (!ignore(scanner, file)) {
            dsfiles.push(file);
          }
          cursor.continue();
        }
        else {
          // We're done enumerating device storage, so get all files from db
          getDBFiles();
        }
      }

      cursor.onerror = function() {
        // We can't scan if we can't read device storage.
        // Perhaps the card was unmounted or pulled out
        console.warning('Error while scanning', cursor.error);
        endscan(scanner);
      };

      function getDBFiles() {
        var store = scanner.db.transaction('files').objectStore('files');
        var getAllRequest = store.mozGetAll();

        getAllRequest.onsuccess = function() {
          var dbfiles = getAllRequest.result;  // Should already be sorted
          compareLists(dbfiles, dsfiles);
        };
      }

      function compareLists(dbfiles, dsfiles) {
        // The dbfiles are sorted when we get them from the db.
        // But the ds files are not sorted
        dsfiles.sort(function(a, b) {
          if (a.name < b.name)
            return -1;
          else
            return 1;
        });

        // Loop through both the dsfiles and dbfiles lists
        var dsindex = 0, dbindex = 0;
        while (true) {
          // Get the next DeviceStorage file or null
          var dsfile;
          if (dsindex < dsfiles.length)
            dsfile = dsfiles[dsindex];
          else
            dsfile = null;

          // Get the next DB file or null
          var dbfile;
          if (dbindex < dbfiles.length)
            dbfile = dbfiles[dbindex];
          else
            dbfile = null;

          // Case 1: both files are null.  If so, we're done.
          if (dsfile === null && dbfile === null)
            break;

          // Case 2: no more files in the db.  This means that
          // the file from ds is a new one
          if (dbfile === null) {
            insertRecord(scanner, dsfile);
            dsindex++;
            continue;
          }

          // Case 3: no more files in ds. This means that the db file
          // has been deleted
          if (dsfile === null) {
            deleteRecord(scanner, dbfile.name);
            dbindex++;
            continue;
          }

          // Case 4: two files with the same name.
          // 4a: date and size are the same for both: do nothing
          // 4b: file has changed: it is both a deletion and a creation
          if (dsfile.name === dbfile.name) {
            var lastModified = dsfile.lastModifiedDate;
            if ((lastModified && lastModified.getTime() !== dbfile.date) ||
                dsfile.size !== dbfile.size) {
              deleteRecord(scanner, dbfile.name);
              insertRecord(scanner, dsfile);
            }
            dsindex++;
            dbindex++;
            continue;
          }

          // Case 5: the dsfile name is less than the dbfile name.
          // This means that the dsfile is new.  Like case 2
          if (dsfile.name < dbfile.name) {
            insertRecord(scanner, dsfile);
            dsindex++;
            continue;
          }

          // Case 6: the dsfile name is greater than the dbfile name.
          // this means that the dbfile no longer exists on disk
          if (dsfile.name > dbfile.name) {
            deleteRecord(scanner, dbfile.name);
            dbindex++;
            continue;
          }

          // That should be an exhaustive set of possiblities
          // and we should never reach this point.
          console.error('Assertion failed');
        }

        // Push a special value onto the queue so that when it is
        // processed we can trigger a 'scanend' event
        insertRecord(scanner, null);
      }
    }
  }


  // Pass in a file, or a filename.  The function queues it up for
  // metadata parsing and insertion into the database, and will send a
  // Scanner change event (possibly batched with other changes).
  // Ensures that only one file is being parsed at a time, but tries
  // to make as many db changes in one transaction as possible.  The
  // special value null indicates that scanning is complete.  If the
  // 2nd argument is a File, it should come from enumerate() so that
  // the name property does not include the directory prefix.  If it
  // is a name, then the directory prefix must already have been
  // stripped.
  function insertRecord(scanner, fileOrName) {
    var details = scanner.details;

    // Add this file to the queue of files to process
    details.pendingInsertions.push(fileOrName);

    // If the queue is already being processed, just return
    if (details.processingQueue)
      return;

    // Otherwise, start processing the queue.
    processQueue(scanner);
  }

  // Delete the database record associated with filename.
  // filename must not include the directory prefix.
  function deleteRecord(scanner, filename) {
    var details = scanner.details;

    // Add this file to the queue of files to process
    details.pendingDeletions.push(filename);

    // If there is already a transaction in progress return now.
    if (details.processingQueue)
      return;

    // Otherwise, start processing the queue
    processQueue(scanner);
  }

  function whenDoneProcessing(scanner, f) {
    var details = scanner.details;
    if (details.processingQueue)
      details.whenDoneProcessing.push(f);
    else
      f();
  }

  function processQueue(scanner) {
    var details = scanner.details;

    details.processingQueue = true;

    // Now get one filename off a queue and store it
    next();

    // Take an item from a queue and process it.
    // Deletions are always processed before insertions because we want
    // to clear away non-functional parts of the UI ASAP.
    function next() {
      if (details.pendingDeletions.length > 0) {
        deleteFiles();
      }
      else if (details.pendingInsertions.length > 0) {
        insertFile(details.pendingInsertions.shift());
      }
      else {
        details.processingQueue = false;
        if (details.whenDoneProcessing.length > 0) {
          var functions = details.whenDoneProcessing;
          details.whenDoneProcessing = [];
          functions.forEach(function(f) { f(); });
        }
      }
    }

    // Delete all of the pending files in a single transaction
    function deleteFiles() {
      var transaction = scanner.db.transaction('files', 'readwrite');
      var store = transaction.objectStore('files');

      deleteNextFile();

      function deleteNextFile() {
        if (details.pendingDeletions.length === 0) {
          next();
          return;
        }
        var filename = details.pendingDeletions.shift();
        var request = store.delete(filename);
        request.onerror = function() {
          // This probably means that the file wasn't in the db yet
          console.warn('Scanner: Unknown file in deleteRecord:',
                       filename, getreq.error);
          deleteNextFile();
        };
        request.onsuccess = function() {
          // We succeeded, so remember to send out an event about it.
          queueDeleteNotification(scanner, filename);
          deleteNextFile();
        };
      }
    }

    // Insert a file into the db. One transaction per insertion.
    // The argument might be a filename or a File object
    // If it is a File, then it came from enumerate and its name
    // property already has the directory stripped off.  If it is a
    // filename, it came from a device storage change event and we
    // stripped of the directory before calling insertRecord.
    function insertFile(f) {
      // null is a special value pushed on to the queue when a scan()
      // is complete.  We use it to trigger a scanend event
      // after all the change events from the scan are delivered
      if (f === null) {
        sendNotifications(scanner);
        endscan(scanner);
        next();
        return;
      }

      // If we got a filename, look up the file in device storage
      if (typeof f === 'string') {
        var getreq = scanner.storage.get(scanner.directory + f);
        getreq.onerror = function() {
          console.warn('Scanner: Unknown file in insertRecord:',
                       scanner.directory + f, getreq.error);
          next();
        };
        getreq.onsuccess = function() {
          parseMetadata(getreq.result, f);
        };
      }
      else {
        // otherwise f is the file we want
        parseMetadata(f, f.name);
      }
    }

    function parseMetadata(file, filename) {
      if (!file.lastModifiedDate) {
        console.warn('Scanner: parseMetadata: no lastModifiedDate for',
                     filename,
                     'using Date.now() until #793955 is fixed');
      }

      // Basic information about the file
      var fileinfo = {
        name: filename, // we can't trust file.name
        type: file.type,
        size: file.size,
        date: file.lastModifiedDate ?
          file.lastModifiedDate.getTime() :
          Date.now()
      };

      if (fileinfo.date > details.newestFileModTime)
        details.newestFileModTime = fileinfo.date;

      // Get metadata about the file
      scanner.metadataParser(file, gotMetadata, metadataError);
      function metadataError(e) {
        console.warn('Scanner: error parsing metadata for',
                     filename, ':', e);
        // If we get an error parsing the metadata, assume it is invalid
        // and make a note in the fileinfo record that we store in the database
        // If we don't store it in the database, we'll keep finding it
        // on every scan. But we make sure never to return the invalid file
        // on an enumerate call.
        fileinfo.fail = true;
        storeRecord(fileinfo);
      }
      function gotMetadata(metadata) {
        fileinfo.metadata = metadata;
        storeRecord(fileinfo);
      }
    }

    function storeRecord(fileinfo) {
      if (scanner.details.firstscan) {
        // If this is the first scan then we know this is a new file and
        // we can assume that adding it to the db will succeed.
        // So we can just queue a notification about the new file without
        // waiting for a db operation.
        scanner.details.records.push(fileinfo);
        if (!fileinfo.fail) {
          queueCreateNotification(scanner, fileinfo);
        }
        // And go on to the next
        next();
      }
      else {
        // If this is not the first scan, then we may already have a db
        // record for this new file. In that case, the call to add() above
        // is going to fail. We need to handle that case, so we can't send
        // out the new file notification until we get a response to the add().
        var transaction = scanner.db.transaction('files', 'readwrite');
        var store = transaction.objectStore('files');
        var request = store.add(fileinfo);

        request.onsuccess = function() {
          // Remember to send an event about this new file
          if (!fileinfo.fail)
            queueCreateNotification(scanner, fileinfo);
          // And go on to the next
          next();
        };
        request.onerror = function(event) {
          // If the error name is 'ConstraintError' it means that the
          // file already exists in the database. So try again, using put()
          // instead of add(). If that succeeds, then queue a delete
          // notification along with the insert notification.  If the
          // second try fails, or if the error was something different
          // then issue a warning and continue with the next.
          if (request.error.name === 'ConstraintError') {
            // Don't let the higher-level DB error handler report the error
            event.stopPropagation();
            // And don't spew a default error message to the console either
            event.preventDefault();
            var putrequest = store.put(fileinfo);
            putrequest.onsuccess = function() {
              queueDeleteNotification(scanner, fileinfo.name);
              if (!fileinfo.fail)
                queueCreateNotification(scanner, fileinfo);
              next();
            };
            putrequest.onerror = function() {
              // Report and move on
              console.error('Scanner: unexpected ConstraintError',
                            'in insertRecord for file:', fileinfo.name);
              next();
            };
          }
          else {
            // Something unexpected happened!
            // All we can do is report it and move on
            console.error('Scanner: unexpected error in insertRecord:',
                          request.error, 'for file:', fileinfo.name);
            next();
          }
        };
      }
    }
  }

  // Don't send out notification events right away. Wait a short time to
  // see if others arrive that we can batch up.  This is common for scanning
  function queueCreateNotification(scanner, fileinfo) {
    var creates = scanner.details.pendingCreateNotifications;
    creates.push(fileinfo);
    if (scanner.batchSize && creates.length >= scanner.batchSize)
      sendNotifications(scanner);
    else
      resetNotificationTimer(scanner);
  }

  function queueDeleteNotification(scanner, filename) {
    var deletes = scanner.details.pendingDeleteNotifications;
    deletes.push(filename);
    if (scanner.batchSize && deletes.length >= scanner.batchSize)
      sendNotifications(scanner);
    else
      resetNotificationTimer(scanner);
  }

  function resetNotificationTimer(scanner) {
    var details = scanner.details;
    if (details.pendingNotificationTimer)
      clearTimeout(details.pendingNotificationTimer);
    details.pendingNotificationTimer =
      setTimeout(function() { sendNotifications(scanner); },
                 scanner.batchHoldTime);
  }

  // Send out notifications for creations and deletions
  function sendNotifications(scanner) {
    var details = scanner.details;
    if (details.pendingNotificationTimer) {
      clearTimeout(details.pendingNotificationTimer);
      details.pendingNotificationTimer = null;
    }
    if (details.pendingDeleteNotifications.length > 0) {
      var deletions = details.pendingDeleteNotifications;
      details.pendingDeleteNotifications = [];
      notify(scanner, 'deleted', deletions);
    }

    if (details.pendingCreateNotifications.length > 0) {

      // If this is a first scan, and we have records that are not
      // in the db yet, write them to the db now
      if (details.firstscan && details.records.length > 0) {
        var transaction = scanner.db.transaction('files', 'readwrite');
        var store = transaction.objectStore('files');
        for (var i = 0; i < details.records.length; i++)
          store.add(details.records[i]);
        details.records.length = 0;
      }

      var creations = details.pendingCreateNotifications;
      details.pendingCreateNotifications = [];
      notify(scanner, 'created', creations);
    }
  }

  function notify(scanner, type, arg1, arg2) {
    if (scanner.callback) {
      try {
        scanner.callback(type, arg1, arg2);
      }
      catch (e) {
        console.warn('Scanner:', type, 'callback threw', e);
      }
    }
    else {
      if (!scanner.pendingCallbacks)
        scanner.pendingCallbacks = [];
      scanner.pendingCallbacks.push(type, detail);
    }
  }

    var handler = scanner['on' + type];
    var listeners = scanner.details.eventListeners[type];

    // Return if there is nothing to handle the event
    if (!handler && (!listeners || listeners.length == 0))
      return;

    // We use a fake event object
    var event = {
      type: type,
      target: scanner,
      currentTarget: scanner,
      timestamp: Date.now(),
      detail: detail
    };

    // Call the 'on' handler property if there is one
    if (typeof handler === 'function') {
      try {
        handler.call(scanner, event);
      }
      catch (e) {
        console.warn('Scanner: ', 'on' + type, 'event handler threw', e);
      }
    }

    // Now call the listeners if there are any
    if (!listeners)
      return;
    for (var i = 0; i < listeners.length; i++) {
      try {
        var listener = listeners[i];
        if (typeof listener === 'function') {
          listener.call(scanner, event);
        }
        else {
          listener.handleEvent(event);
        }
      }
      catch (e) {
        console.warn('Scanner: ', type, 'event listener threw', e);
      }
    }
  }

  function changeState(scanner, state) {
    if (scanner.state !== state) {
      scanner.state = state;
      if (state === Scanner.READY)
        notify(scanner, 'ready');
      else
        notify(scanner, 'unavailable', state);
    }
  }

  return Scanner;

}());
