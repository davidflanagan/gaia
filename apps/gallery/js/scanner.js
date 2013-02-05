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
    console.startup('Scanner() constructor');
    this.dbname = 'Scanner-' + name;
    this.version = version;
    this.media = media;
    this.files = [];  // An array of names of known files. First is newest.
    this.data = {};   // Maps filenames to file data and metadata.
    this.callback = null;
    this.state = Scanner.READY;
    this.scanning = 0;
    this.pendingDBUpdates = [];
    this.pendingNotifications = null;
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

  /*
    Init sequence:
    
    The constructor calls initDB

    initDB opens the database and asynchronously calls enumerateDB when done

    enumerateDB uses a cursor to enumerate all entries in the db in
    reverse chronological order and stores them in the files[] array. If
    a callback is registered, it calls the cb with type 'append' for
    each entry.  (If no callback is registered it does not queue the 
    notifications but assumes the the client will start with the files[] 
    array and listen for updates to it.)  When enumeration is complete
    it calls initDeviceStorage.

    initDeviceStorage synchronously obtains a device storage object
    for each kind of media storage it needs and registers an device
    storage change event handler for each. It asynchronously queries
    one of the device storage objects to find out if there is actually
    a usable sdcard and sends appropriate events if there is not. But
    before waiting for the result of the availability check it calls
    scan() to begin scanning the device storage objects.

    scan():
     - marks all files in the files[] array as unverified
     - calls the async function scanOneKind for each kind of device storage

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

    Needs a callback argument to synchronize scan with metdata parsing.

   */



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
      console.startup('Scanner db open');
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
        scanner.files.push(fileinfo);
        scanner.data[fileinfo.name] = fileinfo;
        if (scanner.files.length <= 12)
          console.startup('Enumerated ' + scanner.files.length);
        if (scanner.callback) {
          try {
            scanner.callback('append', fileinfo);
          }
          catch(e) {
            console.warn('Scanner: enumeration callback threw', e);
          }
        }
        cursor.continue();
      }
      else {
        console.startup('Scanner enumeration complete');
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
            addFileByName(scanner, kind, filename);
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

  function addFileByName(scanner, kind, filename) {
    var storage = scanner.media[kind].storage;
    storage.get(filename).onsuccess = function(e) {
      var file = e.target.result;
      addFile(scanner, kind, file, function() { persist(); });
    };
  }

  // This updates the scanner state in memory and notifies the client.
  // It then updates the database, or, if we're scanning, queues the update.
  // This function should be useful for change events and scan results.
  function addFile(scanner, kind, file, callback) {
    var filename = file.name;

    // If we already know about this file, then first delete the known file
    if (scanner.data[filename]) {
      removeFile(scanner, filename);
    }

    if (ignore(scanner, file))
      return;

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
      console.warn('MediaDB: error parsing metadata for', filename, ':', e);
      if (callback)
        callback();
    }

    function metadataSuccess(metadata) {
      fileinfo.metadata = metadata;
      scanner.data[filename] = fileinfo;
      var pos = insertNewFile(scanner, fileinfo);
      notify(scanner, 'insert', fileinfo, pos);
      scanner.pendingDBUpdates.push(fileinfo);
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

    delete scanner.data[filename];

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

  function scan(scanner) {
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
          if (ignore(scanner, kind, file)) {
            cursor.continue();
          }
          else {
            addFile(scanner, kind, file, function() { cursor.continue(); });
            console.startup('scan ' + kind + ' ' +
                            scanner.pendingDBUpdates.length);
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
            return
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
        notify(scanner, 'scanend');
        console.startup('Done scanning');
        persist(scanner);
      }
    }
  }

  function persist(scanner) {
    if (scanner.pendingDBUpdates.length === 0)
      return;

    console.startup('saving scan results to db');

    // Scan results are saved to the db in a single transaction. So if
    // anything goes wrong and it fails, everything should fail and
    // the next time the app starts we should be back in the same
    // place... We'll redo the scan and try saving again.
    var txn = scanner.db.transaction('files', 'readwrite');
    var store = txn.objectStore('files');

    for(var i = 0; i < scanner.pendingDBUpdates.length; i++) {
      var update = scanner.pendingDBUpdates[i];
      if (typeof update === 'string') {
        // we're deleting a named file
        store.delete(update);
      }
      else {
        // we're inserting a fileinfo object
        store.put(update);
      }
    }
    scanner.pendingDBUpdates.length = 0;

    txn.oncomplete = function() {
      console.startup('scan results saved');
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
      if (!scanner.pendingNotifications)
        scanner.pendingNotifications = [];
      scanner.pendingNotifications.push(type, arg1, arg2);
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


  Scanner.prototype = {
    setCallback: function(callback) {
      // send all the pending notifications to this callback
      if (this.pendingNotifications) {
        for(var i = 0; i < this.pendingNotifications.length; i += 3) {
          callback(this.pendingNotifications[i], 
                   this.pendingNotifications[i+1], 
                   this.pendingNotifications[i+2]);
        }
        this.pendingNotifications = null;
      }

      // All future notifications will go directly to this callback
      this.callback = callback;
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

    // Delete the named file from device storage.
    // This will cause a device storage change event, which will cause
    // Scanner to remove the file from the database and send out a
    // Scanner change event, which will notify the application UI.
    deleteFile: function deleteFile(kind, filename) {
      if (this.state !== Scanner.READY)
        throw Error('Scanner is not ready. State: ' + this.state);

      var storage = this.media[kind].storage;

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

      for(var kind in this.media) {
        this.media[kind].storage.freeSpace().onsuccess = function(e) {
          callback(e.target.result);
        };
        // Just do this for one of our DeviceStorage objects
        break;
      }
    }
  };

  return Scanner;
}());
