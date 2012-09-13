/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

/**
 * MediaDB.js: a simple interface to DeviceStorage and IndexedDB.
 *
 * Gaia's media apps (Gallery, Music, Videos) read media files from the phone
 * using the DeviceStorage API. They need to keep track of the complete list of
 * media files, as well as the metadata (image sizes, song titles, etc.) that
 * they have extracted from those files. It would be much too slow to scan the
 * filesystem and read all the metadata from all files each time the apps starts
 * up, so the apps need to store filenames and metadata in an IndexedDB
 * database. This library integrates both DeviceStorage and IndexedDB into a
 * single API. It keeps the database in sync with the filesystem and provides
 * notifications when files are added or deleted.
 *
 * Create a MediaDB object with the MediaDB() constructor. It takes three
 * arguments:
 *
 *   mediaType:
 *     one of the DeviceStorage media types such as
 *     "pictures", "movies" or "music".
 *
 *   metadataParser:
 *     your metadata parser function. This function should expect three
 *     arguments. It will be called with a file to parse and two callback
 *     functions. It should read metadata from the file and then pass an object
 *     of metadata to the first callback. If parsing fails it should pass an
 *     Error object or error message to the second callback. If you omit this
 *     argument or pass null, a dummy parser that invokes the callback with an
 *     empty object will be used instead.
 *
 *   options:
 *     An optional object containing additional MediaDB options.
 *     Supported options are:
 *
 *       directory:
 *          a subdirectory of the DeviceStorage directory. If you are only
 *          interested in images in the screenshots/ subdirectory for example,
 *          you can set this property to "screenshots/".
 *
 *       mimeTypes:
 *          an array of MIME types that specifies the kind of files you are
 *          interested in and that your metadata parser function knows how to
 *          handle.
 *
 *       indexes:
 *          an array of IndexedDB key path specifications that specify which
 *          properties of each media record should be indexed. If you want to
 *          search or sort on anything other than the file name specify this
 *          property. "size", "date", "type" are valid keypaths as is
 *          "metadata.x" where x is any metadata property returned by your
 *          metadata parser.
 *
 *       version:
 *          The version of your IndexedDB database. The default value is 1
 *          Setting it to a larger value will delete all data in the database
 *          and rebuild it from scratch. If you ever change your metadata parser
 *          function or alter any of the options above, you should update the
 *          version number.
 *
 * A MediaDB object must asynchronously open a connection to its database, and
 * asynchronously check on the availability of device storage, which means that
 * it is not ready for use when first created. After calling the MediaDB()
 * constructor, set the onready property of the returned object to a callback
 * function. When the database is ready for use, that function will be invoked
 * with the MediaDB object as its this value. (Note that MediaDB does not define
 * addEventListener: you can only set a single onready property.)
 *
 * The DeviceStorage API is not always available, and MediaDB is not usable if
 * DeviceStorage is not usable. If the user removes the SD card from their
 * phone, then DeviceStorage will not be able to read or write files, obviously.
 * Also, when a USB Mass Storage session is in progress, DeviceStorage is not
 * available either. If DeviceStorage is not available when a MediaDB object is
 * created, the onunavailable callback will be invoked instead of the onready
 * callback. Subsequently, onready will be called whenever DeviceStorage becomes
 * available, and onunavailble will be called whenever DeviceStorage becomes
 * unavailable. Media apps can handle the unavailble case by displaying an
 * informative message in an overlay that prevents all user interaction with the
 * app.
 *
 * Typically, the first thing an app will do with a MediaDB object after the
 * onready callback is called is call its enumerate() method. This gets entries
 * from the database and passes them to the specified callback. Each entry that
 * is passed to the callback is an object like this:
 *
 *   {
 *     name:     // the filename (relative to the DeviceStorage root)
 *     type:     // the file MIME type
 *     size:     // the file size in bytes
 *     date:     // file mod time (as ms since the epoch)
 *     metadata: // whatever object the metadata parser returned
 *   }
 *
 * Note that db entries do not include the file itself, but only its name. Use
 * the getFile() method to get a File object by name. If you pass only a
 * callback to enumerate(), it calls the callback once for each entry in the
 * database and then calls the callback with an argument of null to indicate
 * that it is done.
 *
 * By default, entries are returned in alphabetical order by filename and all
 * entries in the database are returned. You can specify other arguments to
 * enumerate() to change the set of entries that are returned and the order that
 * they are enumerated in. The full set of arguments are:
 *
 *   key:
 *     A keypath specification that specifies what field to sort on.
 *     If you specify this argument, it must be one of the values in the
 *     options.indexes array passed to the MediaDB() constructor.
 *     This argument is optional. If omitted, the default is to use the file
 *     name as the key.
 *
 *   range:
 *     An IDBKeyRange object that optionally specifies upper and lower bounds on
 *     the specified key. This argument is optional. If omitted, all entries in
 *     the database are enumerated.
 *
 *   direction:
 *     One of the IndexedDB direction string "next", "nextunique", "prev" or
 *     "prevunique". This argument is optional. If omitted, the default is
 *     "next", which enumerates entries in ascending order.
 *
 *   callback:
 *     The function that database entries should be passed to. This argument is
 *     not optional, and is always passed as the last argument to enumerate().
 *
 * The enumerate() method returns database entries. These include file names,
 * but not the files themselves. enumerate() interacts solely with the
 * IndexedDB; it does not use DeviceStorage. If you want to use a media file
 * (to play a song or display a photo, for example) call the getFile() method.
 * This method takes the filename (the name property of the database entry) as
 * its first argument, and a callback as its second. It looks the named file up
 * with DeviceStorage and passes it to the callback function. You can pass an
 * optional error callback as the third argument. Any error reported by
 * DeviceStorage will be passed to this argument. If the named file does not
 * exist, the error callback will be invoked.
 *
 * enumerate() returns an object with a 'state' property that starts out as
 * 'enumerating' and switches to 'complete' when the enumeration is done. You
 * can cancel a pending enumeration by passing this object to the
 * cancelEnumeration() method. This switches the state to 'cancelling' and then
 * it switches to 'cancelled' when the cancellation is complete. If you call
 * cancelEnumeration(), the callback function you passed to enumerate() is
 * guaranteed not to be called again.
 *
 * If you set the onchange property of a MediaDB object to a function, it will
 * be called whenever files are added or removed from the DeviceStorage
 * directory. The first argument passed to the onchange callback is a string
 * that specifies the type of change that has occurred:
 *
 *   "created":
 *     Media files were added to the device. The second argument is an array of
 *     database entries describing the new files and their metadata. When
 *     DeviceStorage detects the creation of a single new file, this array will
 *     have only a single entry. When the scan() method runs, however it may
 *     detect many new files and the array can be large. Apps may want to handle
 *     these cases differently, incrementally updating their UI when single-file
 *     changes occur and completely rebuilding the UI (with a new call to
 *     enumerate() when many files are added.
 *
 *   "deleted":
 *     Media files were deleted from the device, and their records have been
 *     deleted from the database. The second argument is an array of database
 *     entries that describe the deleted files and their metadata. As with
 *     "created" changes, this array may have multiple entries when the callback
 *     is invoked as a result of a scan() call.
 *     XXX: this API is changing. The second argument is just an array of
 *      filenames, not an array of fileinfo objects.
 *
 * Another MediaDB method is scan(). It takes no arguments and launches an
 * asynchronous scan of DeviceStorage for new, changed, and deleted file. File
 * creations and deletions are batched and reported through the onchange
 * handler. Changes are treated as deletions followed by creations. As an
 * optimization, scan() first attempts a quick scan, looking only for files that
 * are newer than the last scan time. Any new files are reported as creations,
 * and then scan() starts a full scan to search for changed or deleted files.
 * This means that a call to scan() may result in up to three calls to onchange
 * to report new files, deleted files and changed files. This is an
 * implementation detail, however, and apps should be prepared to handle any
 * number of calls to onchange.
 *
 * Other MediaDB methods include:
 *
 *  - updateMetadata(): updates the metadata for a named file
 *
 *  - addFile(): takes a filename and a blob, saves the blob as a file to
 *      device storage, parses its metadata, and updates the database.
 *
 *  - deleteFile(): deletes the named file from device storage and the database
 */

/*
  I need to update this to handle change notifications from ds so that it 
  is no longer necessary to scan each time the app becomes visible.

  The current addFile() method is for writing new files to device
  storage and adding them to the db. And delete file is for deleting
  files and their corresponding db record.  I think I need addRecord
  and deleteRecord methods to keep the db in sync with ds.  Possibly
  internal methods.  Though when the camera uses an open activity to
  open the gallery, it will pass a filename, and the ds notification
  may not have arrived yet, so it may need to be added.  (Note that
  this is kind of a race condition... when we get the event from ds,
  we don't want to falsely recognize this as a file change where we
  treat it as a delete and create pair...)  So maybe the open activity
  just needs to let the ds notificaton arrive.  If the file isn't
  known yet, it oes a settimeout for 50ms and tries again 

  I think I need to do real events and implement EventTarget for real.

  Inputs to mediadb:

     change notifications from ds
     scan results
     addFile(), removeFile()

  Outputs:

     change notifications
     mounted/unmounted notifications
     (should mediadb handle the ux modal overlays and non-modal scanning?)
     (or do that in a separate mediadbux.js module?)

  ds added/removed notification:

     change event input -> addRecord -> change event output
     
  addFile/removeFile:

     ds add/remove file -> change event input-> addRecord -> change event output

  scan:

    quick scan -> addRecord() -> single change event output
    full scan -> removeRecords() -> single change event output
    full scan -> addRecords() -> single change event output


 DONE  does scan() have to batch everything itself, or can it just call
   addRecord and removeRecord and have those serialize all the async
   operations and batch stuff?  I think the scan algorithm will be
   much simpler if addRecord() and removeRecord() queue things up and
   serialize all of the metadata and db stuff See the code in
   gallery/js/MetadataParser.js for an example. Doing this in
   addRecord() would mean we can remove it from there, too.

  DONE for quick scan, instead of storing the last scan time, can I instead
  just query the db for the most recent file?  That would mean
  automatically creating an index for the date field, but I want that
  anyway, really.  Then I can get rid of localStorage in the apps and
  don't even have to switch to asyncStorage.  Note that I'd only have
  to query the db for the newest file in the constructor.

->    Add scanstart and scanend output events
      partially done with just onscanstart and onscancomplete properties

->    Implement addEventListener() and removeEventListener methods
        so we're not just relying on onchange, onready, etc.

->   should mediadb automatically run a scan when ds is mounted? Maybe
  apps never need to do that.  Could scan() become an internal method?
  If so, mediadb would fire scanstart and scanend events and the scanend
  event would include scan results so that UX could show stuff
  This is probably the way to go. The idea is that mediadb is a painless
  model of the filesystem. Apps should just be able to create and forget
  and not have to worry about scanning

->  Should I replace the MediaDB constructor with a factory function?
  Then I wouldn't need an onready callback... I'd just pass a callback
  to the factory and have it pass the mediadb object to the callback
  when it was ready.  (But then I'd still need separate on available,
  on unavailable events)

-> update documentation

-> As part of this refactor, I need to write tests.

     Put a bunch of dummy files in /sdcard/mediadbtest/ or something
       like that. Pretend they're all photos and give them .jpeg
       extensions to make device storage happy. Use the file contents
       as stringified metadata, so the metadata parser just does JSON.parse
       on file contents and returns that.  (or just use plain strings)

     then create a mediadb, start a scan (or do I build that in?)
       and see if we get change events for all the files.
       then enumerate and make sure we get them all
       then add and delete files and see if we get events for them
       even try overwriting a file and see if we get delete/create

     Then close teh mediadb (may need to add a method for this)
       and reopen it. Enumerate to make sure we still get all files
       see that a scan happens (scanstart scancomplete) but that
       it doesn't find anything new.

     Add a file of a different type (using a different devce storage object)
       and verify that we don't pick it up?

     Verify that the metadata for the files is correct.

     Verify that we can sort by metadata and 


 */

function MediaDB(mediaType, metadataParser, options) {
  this.mediaType = mediaType;
  this.metadataParser = metadataParser;
  if (!options)
    options = {};
  this.indexes = options.indexes || [];
  this.version = options.version || 1;
  this.directory = options.directory || '';
  this.mimeTypes = options.mimeTypes;
  this.ready = false;

  // Properties for queuing up db insertions and deletions and also
  // for queueing up notifications to be sent
  this._pendingInsertions = [];   // Array of filenames to insert
  this._pendingDeletions = [];    // Array of filenames to remove
  this._pendingCreateNotifications = [];  // Array of fileinfo objects
  this._pendingDeleteNotifications = [];  // Ditto
  this._pendingNotificationTimer = null;

  // This property holds the modification date of the newest file we know about.
  // We need to know the newest file in order to look for newer ones during
  // scanning. We initialize newestFileModTime during initialization by 
  // actually checking the database (using the date index). We also update
  // this property every time a new record is added to the database.
  this.newestFileModTime = 0;

  // Define a dummy metadata parser if we're not given one
  if (!this.metadataParser) {
    this.metadataParser = function(file, callback) {
      setTimeout(function() { callback({}); }, 0);
    }
  }

  var media = this;  // for the nested functions below

  // Set up IndexedDB
  var indexedDB = window.indexedDB || window.mozIndexedDB;
  if (IDBObjectStore && IDBObjectStore.prototype.mozGetAll) {
    IDBObjectStore.prototype.getAll = IDBObjectStore.prototype.mozGetAll;
  }

  this.dbname = 'MediaDB/' + mediaType + '/' + this.directory;
  var openRequest = indexedDB.open(this.dbname, this.version);

  // This should never happen for Gaia apps
  openRequest.onerror = function(e) {
    console.error('MediaDB():', openRequest.error.name);
  };

  // This should never happen for Gaia apps
  openRequest.onblocked = function(e) {
    console.error('indexedDB.open() is blocked in MediaDB()');
  };

  // This is where we create (or delete and recreate) the database
  openRequest.onupgradeneeded = function(e) {
    var db = openRequest.result;

    // If there are already existing object stores, delete them all
    // If the version number changes we just want to start over.
    var existingStoreNames = db.objectStoreNames;
    for (var i = 0; i < existingStoreNames.length; i++) {
      db.deleteObjectStore(existingStoreNames);
    }

    // Now build the database
    var filestore = db.createObjectStore('files', { keyPath: 'name' });
    // Always index the files by modification date
    filestore.createIndex('date', 'date');
    // And index them by any other file properties or metadata properties
    // passed to the constructor
    media.indexes.forEach(function(indexName)  {
      if (indexName === 'name' || indexName === 'date') 
        return;
      // the index name is also the keypath
      filestore.createIndex(indexName, indexName);
    });
  }

  // This is called when we've got the database open and ready.
  // Call the onready callback
  openRequest.onsuccess = function(e) {
    media.db = openRequest.result;

    // Log any errors that propagate up to here
    media.db.onerror = function(event) {
      console.error('MediaDB: ', event.target.error && event.target.error.name);
    }

    // Query the db to find the modification time of the newest file
    var cursorRequest =
      media.db.transaction('files', 'readonly')
      .objectStore('files')
      .index('date')
      .openCursor(null, 'prev');
    
    cursorRequest.onerror = function() {
      // If anything goes wrong just display an error.
      // If this fails, don't even attempt error recovery
      console.error('MediaDB initialization error', cursorRequest.error);
    };
    cursorRequest.onsuccess = function() {
      var cursor = cursorRequest.result;
      if (cursor) {
        media.newestFileModTime = cursor.value.date;
      }
      else {
        // No files in the db yet, so use a really old time
        media.newestFileModTime = 0;
      }

      // The DB is initialized, and we've got our mod time
      // so move on and initialize device storage
      initDeviceStorage();
    };
  };

  function initDeviceStorage() {
    // Set up DeviceStorage
    // If storage is null, then there is no sdcard installed and
    // we have to abort.
    media.storage = navigator.getDeviceStorage(mediaType);

    // Handle change notifications from device storage
    media.storage.onchange = function(e) {
      switch(e.reason) {
      case 'available':
        media.ready = true;
        if (media.onready)
          media.onready();
        break;
      case 'unavailable':
      case 'shared':
        media.ready = false;
        if (media.onunavailable)
          media.onunavailable(e.reason);
        break;
      case 'created':
        media._insertRecord(e.path);
        break;
      case 'deleted':
        media._deleteRecord(e.path);
        break;
      }
    };

    // Use stat() to figure out if there is actually an sdcard there
    // and call onready or onunavailable based on the result
    var statreq = media.storage.stat();
    statreq.onsuccess = function(e) {
      var stats = e.target.result;
      // XXX
      // If we don't get any state, then assume that means 'available'
      // This avoids version skew and make this code work with older
      // versions of gecko that have stat() but don't have the state property
      if (!stats.state || stats.state === 'available') {
        media.ready = true;
        if (media.onready)
          media.onready();
      }
      else {
        // XXX: this is not working right now
        // stat fails instead of returning us the card state
        // https://bugzilla.mozilla.org/show_bug.cgi?id=782351
        if (media.onunavailable)
          media.onunavailable(stats.state);
      }
    };
    statreq.onerror = function(e) {
      // XXX stat fails for unavailable and shared,
      // https://bugzilla.mozilla.org/show_bug.cgi?id=782351
      // No way to distinguish these cases so just guess
      if (media.onunavailable)
        media.onunavailable('unavailable');
      console.error('stat() failed', statreq.error && statreq.error.name);
    };
  }
}

MediaDB.prototype = {
  get onready() {
    return this._onready;
  },
  // If the user sets onready when the db is already ready, call it
  set onready(cb) {
    this._onready = cb;
    if (this.ready)
      setTimeout(cb.bind(this), 0);
  },

  // Look up the specified filename in DeviceStorage and pass the
  // resulting File object to the specified callback.
  getFile: function getFile(filename, callback, errback) {
    var getRequest = this.storage.get(filename);
    getRequest.onsuccess = function() {
      callback(getRequest.result);
    };
    getRequest.onerror = function() {
      var errmsg = getRequest.error && getRequest.error.name;
      if (errback)
        errback(errmsg);
      else
        console.error('MediaDB.getFile:', errmsg);
    }
  },

  // Delete the named file from device storage.
  // This will cause a device storage change event, which will cause
  // mediadb to remove the file from the database and send out a 
  // mediadb change event, which will notify the application UI.
  deleteFile: function deleteFile(filename) {
    this.storage.delete(filename).onerror = function(e) {
      console.error('MediaDB.deleteFile(): Failed to delete', filename,
                    'from DeviceStorage:', e.target.error);
    };
  },

  // 
  // Save the specified blob to device storage, using the specified filename.
  // This will cause device storage to send us an event, and that event
  // will cause mediadb to add the file to its database, and that will
  // send out a mediadb event to the application UI.
  // 
  addFile: function addFile(filename, file) {
    var media = this;

    // Delete any existing file by this name, then save the file.
    var deletereq = media.storage.delete(filename);
    deletereq.onsuccess = deletereq.onerror = save;
    
    function save() {
      media.storage.addNamed(file, filename).onerror = function() {
        console.error('MediaDB: Failed to store', filename,
                      'in DeviceStorage:', storeRequest.error);
      };
    }
  },

  // Look up the database record for the named file, and copy the properties
  // of the metadata object into the file's metadata, and then write the
  // updated record back to the database. The third argument is optional. If
  // you pass a function, it will be called when the metadata is written.
  updateMetadata: function(filename, metadata, callback) {
    var media = this;

    // First, look up the fileinfo record in the db
    var read = media.db.transaction('files', 'readonly')
      .objectStore('files')
      .get(filename);

    read.onerror = function() {
      console.error('MediaDB.updateMetadata called with unknown filename');
    };

    read.onsuccess = function() {
      var fileinfo = read.result;

      // Update the fileinfo metadata
      Object.keys(metadata).forEach(function(key) {
        fileinfo.metadata[key] = metadata[key];
      });

      // And write it back into the database.
      var write = media.db.transaction('files', 'readwrite')
        .objectStore('files')
        .put(fileinfo);

      write.onerror = function() {
        console.error('MediaDB.updateMetadata: database write failed',
                      write.error && write.error.name);
      };

      if (callback) {
        write.onsuccess = function() {
          callback();
        }
      }
    }
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
  // or 'cancelled'.
  //
  enumerate: function enumerate(key, range, direction, callback) {
    if (!this.db)
      throw Error('MediaDB is not ready yet. Use the onready callback');

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

    cursorRequest.onsuccess = function() {
      // If the enumeration has been cancelled, return without
      // calling the callback and without calling cursor.continue();
      if (handle.state === 'cancelling') {
        handle.state = 'cancelled';
        return;
      }

      var cursor = cursorRequest.result;
      if (cursor) {
        callback(cursor.value);
        cursor.continue();
      }
      else {
        // Final time, tell the callback that there are no more.
        handle.state = 'complete';
        callback(null);  // XXX: is this actually useful?
      }
    };

    return handle;
  },

  // Cancel a pending enumeration. After calling this the callback for
  // the specified enumeration will not be invoked again.
  cancelEnumeration: function(handle) {
    if (handle.state === 'enumerating')
      handle.state = 'cancelling';
  },

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
  scan: function scan() {
    if (!this.db)
      throw Error('MediaDB is not ready yet. Use the onready callback');

    if (this.onscanstart) 
      this.onscanstart();

    var media = this;

    // First, scan for new files since the last scan, if there was one
    // When the quickScan is done it will begin a full scan.  If we don't
    // have a last scan date, then we just begin a full scan immediately
    if (media.newestFileModTime > 0) {
      quickScan(media.newestFileModeTime);
    }
    else {
      fullScan();
    }

    // Return true if media db should ignore this file.
    // If the file name begins with a . we'll ignore it.
    // (. files seem to be created during USB Mass Storage sessions on a Mac)
    // If an array of media types was specified when the MediaDB was created
    // and the type of this file is not a member of that list, then ignore it.
    function ignore(file) {
      if (file.name[file.name.lastIndexOf('/')+1] === '.')
        return true;
      if (media.mimeTypes && media.mimeTypes.indexOf(file.type) === -1) 
        return true;
      return false;
    }

    // Do a quick scan and then follow with a full scan
    function quickScan(timestamp) {
      var cursor = media.storage.enumerate(media.directory, {
        since: new Date(timestamp)
      });

      cursor.onsuccess = function() {
        var file = cursor.result;
        if (file) {
          if (!ignore(file)) 
            media._insertRecord(file);
          cursor.continue();
        }
        else {
          // Quick scan is done, so move on to the slower, more thorough stage
          fullScan();
        }
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

      // The db may be busy right about now, processing files that
      // were found during the quick scan.  So we'll start off by
      // enumerating all files in device storage
      var dsfiles = [];
      var cursor = media.storage.enumerate(media.directory);
      cursor.onsuccess = function() {
        var file = cursor.result;
        if (file) {
          if (!ignore(file)) {
            dsfiles.push(file);
          }
          cursor.continue();
        }
        else {
          // We're done enumerating device storage, so get all files from db
          getDBFiles();
        }
      }

      function getDBFiles() {
        var store = media.db.transaction('files').objectStore('files');
        var getAllRequest = store.getAll();
        
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
            media._insertRecord(dsfile);
            dsindex++;
            continue;
          }

          // Case 3: no more files in ds. This means that the db file
          // has been deleted
          if (dsfile === null) {
            media._deleteRecord(dbfile.name);
            dbindex++;
            continue;
          }

          // Case 4: two files with the same name.
          // 4a: date and size are the same for both: do nothing
          // 4b: file has changed: it is both a deletion and a creation
          if (dsfile.name === dbfile.name) {
            if (dsfile.lastModifiedDate.getTime() !== dbfile.date ||
                dsfile.size !== dbfile.size) {
              media._deleteRecord(dbfile.name);
              media._insertRecord(dsfile);
            }
            dsindex++;
            dbindex++;
            continue;
          }

          // Case 5: the dsfile name is less than the dbfile name.
          // This means that the dsfile is new.  Like case 2
          if (dsfile.name < dbfile.name) {
            media._insertRecord(dsfile);
            dsindex++;
            continue;
          }

          // Case 6: the dsfile name is greater than the dbfile name.
          // this means that the dbfile no longer exists on disk
          if (dsfile.name > dbfile.name) {
            media._deleteRecord(dbfile.name);
            dbindex++;
            continue;
          }

          // That should be an exhaustive set of possiblities
          // and we should never reach this point.
          console.error('Assertion failed');
        }

        // Push a special value onto the queue so that when it is 
        // processed we can trigger a 'scancomplete' event
        media._insertRecord(null);
      }
    }
  },


  // An internal method. Pass in a file, or a filename.
  // The function queue it up for metadata parsing and insertion
  // into the database, and will send a mediadb change event (possibly batched
  // with other changes).  Ensures that only one file is being parsed
  // at a time, but tries to make as many db changes in one transaction
  // as possible.  The special value null indicates that scanning is complete.
  _insertRecord: function(fileOrName) {
    // Add this file to the queue of files to process
    this._pendingInsertions.push(fileOrName);

    // If the queue is already being processed, just return
    if (this.processingQueue)
      return;

    // Otherwise, start processing the queue.
    this._processQueue();
  },

  _deleteRecord: function(filename) {
    // Add this file to the queue of files to process
    this._pendingDeletions.push(filename);

    // If there is already a transaction in progress return now.
    if (this.processingQueue)
      return;

    // Otherwise, start processing the queue
    this._processQueue();
  },

  _processQueue: function() {
    var media = this;

    this.processingQueue = true;
    
    // Now get one filename off a queue and store it
    next();

    // Take an item from a queue and process it.
    // Deletions are always processed before insertions because we want
    // to clear away non-functional parts of the UI ASAP.
    function next() {
      if (media._pendingDeletions.length > 0) {
        deleteFiles();
      }
      else if (media._pendingInsertions.length > 0) {
        insertFile(media._pendingInsertions.shift());
      }
      else {
        this.processingQueue = false;
      }
    }

    // Delete all of the pending files in a single transaction
    function deleteFiles() {
      var transaction = media.db.transaction('files', 'readwrite');
      var store = transaction.objectStore('files');

      deleteNextFile();

      function deleteNextFile() {
        if (media._pendingDeletions.length === 0) 
          return;
        var filename = media._pendingDeletions.shift();
        var request = store.delete(filename);
        request.onerror = function() {
          // This probably means that the file wasn't in the db yet
          console.warn('MediaDB: Unknown file in _deleteRecord:',
                       filename, getreq.error);
          deleteNextFile();
        };
        request.onsuccess = function() {
          // We succeeded, so remember to send out an event about it.
          media._queueDeleteNotification(filename);
          deleteNextFile();
        };
      }
    }

    // Insert a file into the db. One transaction per insertion.
    // The argument might be a filename or a File object
    function insertFile(f) {
      // null is a special value pushed on to the queue when a scan()
      // is complete.  We use it to trigger a scancomplete event
      // after all the change events from the scan are delivered
      if (f === null) {
        media._queueInsertNotification(null);
        return;
      }

      // If we got a filename, look up the file in device storage
      if (typeof f === 'string') {
        var getreq = media.storage.get(filename);
        getreq.onerror = function() {
          console.warn('MediaDB: Unknown file in _insertRecord:',
                       filename, getreq.error);
          next();
        };
        getreq.onsuccess = function() {
          parseMetadata(getreq.result);
        };
      }
      else {
        // otherwise f is the file we want
        parseMetadata(f);
      }
    }
    
    function parseMetdata(file) {
      // Basic information about the file
      var fileinfo = {
        name: file.name,
        type: file.type,
        size: file.size,
        date: file.lastModifiedDate.getTime()
      }
      
      if (fileinfo.date > media.newestFileModTime)
        media.newestFileModTime = fileinfo.date;

      // Get metadata about the file
      media.metadataParser(file, gotMetadata, metadataError);
      function metadataError(e) {
        console.warn('MediaDB: error parsing metadata for',
                     file.name, ':', e);
        // If we get an error parsing the metadata, treat the file
        // as malformed, and don't insert it into the database.
        next();
      }
      function gotMetadata(metadata) {
        fileinfo.metadata = metadata;
        storeRecord(fileinfo);
      }
    }

    function storeRecord(fileinfo) {
      var transaction = media.db.transaction('files', 'readwrite');
      var store = transaction.objectStore('files');
      var request = store.add(fileinfo);
      request.onsuccess = function() {
        // Remember to send an event about this new file
        media._queueCreateNotification(fileinfo);
        // And go on to the next
        next();
      };
      request.onerror = function(event) {
        // If the error name is "ConstraintError" it means that the
        // file already exists in the database. So try again, using put()
        // instead of add(). If that succeeds, then queue a delete
        // notification along with the insert notification.  If the 
        // second try fails, or if the error was something different
        // then issue a warning and continue with the next.
        if (request.error.name === "ConstraintError") {
          // Don't let the higher-level DB error handler report the error
          event.stopPropagation();
          // And don't spew a default error message to the console either
          event.preventDefault();
          var putrequest = store.put(fileinfo);
          putrequest.onsuccess = function() {
            media._queueDeleteNotification(fileinfo.name);
            media._queueCreateNotification(fileinfo);
            next();
          };
          putrequest.onerror = function() {
            // Report and move on
            console.error("MediaDB: unexpected ConstraintError", 
                          "in _insertRecord for file:", fileinfo.name);
            next();
          };
        }
        else {
          // Something unexpected happened!
          // All we can do is report it and move on
          console.error("MediaDB: unexpected error in _insertRecord:",
                        request.error, "for file:", fileinfo.name);
          next();
        }
      };
    }
  },

  // Don't send out notification events right away. Wait a short time to
  // see if others arrive that we can batch up.  This is common for scanning
  // But if we're invoked with null as the argument that is the signal that
  // a scan() has just completed, so push out all notifications right away
  // and trigger a scancomplete notification
  _queueCreateNotification: function(fileinfo) {
    if (fileinfo) {
      this._pendingCreateNotifications.push(fileinfo);
      this._resetNotificationTimer();
    }
    else {
      // special end-of-scan case
      if (this._pendingNotificationTimer)
        clearTimeout(this._pendingNotificationTimer);
      this._notify();
      if (this.onscancomplete)
        this.onscancomplete();
    }
  },

  _queueDeleteNotification: function(filename) {
    this._pendingDeleteNotifications.push(filename);
    this._resetNotificationTimer();
  },

  _resetNotificationTimer: function() {
    if (this._pendingNotificationTimer)
      clearTimeout(this._pendingNotificationTimer);
    this._pendingNotificationTimer =
      setTimeout(this._notify.bind(this), MediaDB.NOTIFICATION_HOLD_TIME);
  },

  // Send out notifications for creations and deletions
  _notify: function() {
    if (this.onchange) {
      if (this._pendingDeleteNotifications.length > 0) {
        var deletions = this._pendingDeleteNotifications;
        this._pendingDeleteNotifications = [];
        try {
          this.onchange('deleted', deletions);
        }
        catch(e) {
          console.error("MediaDB: onchange delete handler threw", e);
        }
      }
      
      if (this._pendingCreateNotifications.length > 0) {
        var creations = this._pendingCreateNotifications;
        this._pendingCreateNotifications = [];
        try {
          this.onchange('created', creations);
        }
        catch(e) {
          console.error("MediaDB: onchange create handler threw", e);
        }
      }
    }
  }
};

// Hold create and delete onchange events for this long to batch up events
// that come in rapid succession. This happens when scanning, e.g.
MediaDB.NOTIFICATION_HOLD_TIME = 100;