/* -*- Mode: js; js-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

// XXX
// I've tried to improve scanning by never doing a fullscan, just verifying
// that the existing files still exist. But that's not good enough if users
// copy older files onto the sdcard after using the camera, e.g. So I think
// I need to go back to the fullscan logic.
//


/*
Ideas to improve gallery startup time:

What if I didn't use IndexedDB at all?
  create and store thumbnails in their own files on the sdcard

Then the full list of photos and videos would be /sdcard/.Gallerydb/index

Given that just opening the DB takes at least 200ms, I bet I can read
the entire file in less time.  Thumbnails are already coming from
files in the indexeddb directory somewhere, so it shouldn't be any
slower to read them from the sdcard, unless the sdcard is much slower
than the /data partition.  I can probably create the blob urls during
the startup process and just retain them. (Or, if I just store File
objects, they won't get stringified when I persist the files[] array).

JSON or CSV or binary format?
  easiest to just JSON.stringify my in-memory array.
  should be plenty fast enough.

  Or is there a more compact representation where we just
  store an array of filenames and then map those names to their data.

Each entry has:

  filename
  date
  type: image or video
  width and height
  offset+size of preview image
 
keep the file in sorted order and write it after each scan or
  after each new photo is taken.

Note that one very nice feature of doing it this way is that the right
thing happens when the user swaps sdcards.


I've got this scheme implemented.  Reading the entire index file is as
fast as enumerating just one or two db entries, I think.

Dealing with thumbnails is a little slower, probably because I'm
saving them to the same partition that I'm scanning. (Hmm: to improve
scanning speed, do I need to give the thumbnail files a different
extension so they don't scan as images?  Or does device storage
automatically ignore them beause they're under a hidden directory?)

When I scan a new file, the thumbnail is an in-memory blob, so I have
to write it to disk, then read the file back and create a blob
url. This extra step takes extra time (but conserves memory). For the
first page of thumbnails, at least, I've got to wait until the write
completes before continuing because otherwise the file won't be there
when we try to display it.  Removing the wait takes the full scan from
150s to 105s or so, so that is a big win, but I can only do it after
the first page of results.  Or maybe I need to change the thumbnail
query/cache thing to try again if no thumbnail found.... Actually,
what if I just used the in-memory blob for the first scan results, at
least in the first scan case.  that's a good optimization


Moving metadata parsing to a worker thread makes almost no difference
to scan time.  I'm surprised.

scan time is overall kind of slow. I think I might need to throw up a
bigger scan overlay, like the one proposed for the music app, and
maybe that will be good enough.

Other ways to move forward on startup performance:

  - use the jsmin built in.
     how can I combine that with loading stuff dynamically?

  - load scanning+metadata parsing code after enumerating

  - load editing code dynamically

  - load large image display code and video playback code dynamically.

  - refactor these modules so that they do their thing (start the
    scan, enable UI buttons) only after the necessary code is loaded.
  
  - add bigger scanning UI that shows up sooner.

DONE - save thumbnails for first page as typed arrays in the index file
    so we have them right away.  Can't JSON.stringify them, so will
    need to think about encoding options.

add logging output for DOMContentLoaded, load, etc.  Maybe a mutation
observer to listen for scripts and register onload handlers for them?
done: shared/js/startup_timing.js

make sure scripts are before stylesheets.  Check time difference
   doesn't seem to make much difference. Maybe because of deferred scripts?

edit build/webapp-optimize.js to aggregate js files and see what
difference that makes
   surprisingly little difference. I've turned this off again.

move stuff from localized to content loaded. Get rid of the hidden body
stuff, since there is no localized text on the main screen of gallery
   it doesn't seem like this will make any real difference.
   DOMContentLoaded is only 7.5ms before the localized event

start db init in the first (non-deferred) script.  Or at least
start a query for the top 12 thumbnails in the first script.

If I'm going to start mediadb before the onload event, I've got to
be careful because the event handlers (scanstart, etc.) need the DOM defined. 
(a whenLoaded(f) metafunction?)
 
Start taking features out until full startup... Don't load the
editor code or the mediaframe code, e.g. until we've drawn the
screen.  Will have to be careful about event handlers and calling
code before it is loaded.

What would happen if mediadb used a worker thread for scanning or even
for metadata parsing?

Problems with mediadb.js:

   the fact that the class has an enumerate method with db parameters
   (as used by the music app) means that new records really need to be
   inserted into the db before they are passed through to the 
   created event handler.  Otherwise the app could have a model of
   the fs that was different than the state of the db.

   I could fix that by using the db only as a persistant store
   for the records, but doing all the indexing and enumeration on
   an in-memory copy of file and metadata records.  (Note that we
   could still have the addMetadata() method to save data, but just not
   the db query methods.)

   Or, I could fix it (for the gallery app) by just getting rid of
     the fancy enumeration options.  Then I might not even need 
     indexeddb. It might be enough just to store an array of records
     as a single entry in asyncStorage.  

     TEST this: how long does it take to read and write my entire
     files[] array in the gallery app? And do the blobs survive the
     round trip?
        
       saving 1000 records takes 30s!  (probably makes copies of all the blobs)
       Even reading them back takes 1 or 2 seconds, so this is too long.
       (stringified length of files[] is 213kb, but that doesn't count blobs)

       I need to use indexeddb with mozGetAll() indexed by date

       if I just save 15 records, I can read them back in 100-200ms
       (the very first test too 800, but I haven't been able to repeat that)


   Another problem: the startup logic for mediadb kind of assumes that
     the UI is ready first. If we get onunavailable, we need to 
     the document to be ready so we can display the overlay. If we get
     onchanged, we need to display the new thing.  

   So, if I wasn't using mediadb for the gallery app, how would I
   start up?

      1) At the top of the first (non-deferred) script, start a query
         for the first page of records, with the hope that the query
         will return by the time we get DOMContentLoaded. Since this
         query returns the most recent known files, we can use the
         date of the first for the scan.
         
         (If the records are stored in a regular indexeddb with each
         record a separate object instead of storing a single array of
         records, then I could use mozGetAll() to query as long as
         there was an index by date.)

      2) Query the rest of the records.  (If using indexeddb with each
         record a separate entry in the db, then maybe this plus the
         above is all one query, using mozGetAll repeatedly, but with
         the hope of at least having the 12 most recent photos and
         videos known ASAP.) Otherwise, maybe querying the rest of the
         records just reads a couple of giant objects.

      3) Start scanning for new files, using the date from above. We
         wait until the enumeration of existing files is complete because
         this gives us an easier way to distinguish new from changed
         files. (And also allows us to do a full scan by just checking
         known files to ensure they still exist instead of scanning
         them all again.)

         Note that in the first run case, the queries in 1+2 should 
         return quickly, so we should get to the scan quickly.

         As new files are found, metadata parsing is done as currently.

         It is important that we can report the files before they are
         commited to the database.  If I could write the records from
         oldest to newest, then if the write didn't complete, the next
         scan would find all of the files that hadn't been saved.

         So don't write anything back to the db until scanning is done.

      4) In all of the steps above, all we are doing is building an
         array of fileinfo objects. There is no UI involved, so this
         can be done before DOMContentLoaded
         (Note the internal array of records will include those with
          fail:true that should be ignored. I'll want to not pass those
          on to the client).

      5) Once we do get DOMContentLoaded, we want to get thumbnails 
         on the screen ASAP. So we grab the set of records we
         know about so far, register an event handler to get ones that
         are still coming display all we can.

   To do this with mediadb, we'd change it so that it maintains an
   in-memory copy of the data, and it starts building its model of
   the filesystem as fast as it can as soon as it is created, with
   no need to explictly call enumerate or scan.  And then totally
   simplify the scan logic.
         
   Could I also change it to support multiple device storage objects 
   or would I still do that in gallery itself? If the library
   handled multiple storage types, then gallery wouldn't have to
   maintain its own files[] array. 
   
   what if the new mediadb was called medialist and it exported a
   linked list of fileinfo records?  (No, finding the right insertion
   position for new files would be inefficient. Would have to use a 
   binary tree. Easier to resize an array, I think).

   How do I handle the transition from unattended self-initialization
   to registering callbacks on DOMContentLoaded?  Does the gallery app
   just have to manually check the state and array of files and then
   register callbacks for updates?  Is it simpler if there is just a
   single onchange callback which, when registered sends initial state?
   That would be a nice API for gallery, so I don't have to handle 
   two separate cases (already inited by the time we get domcontentloaded
   vs not initialized yet).

   if the new mediadb is going to maintain its state in memory, it is
   going to have a filename->data map because the scanning code will
   need that to query whether a given file is already known or not.
   
   That means that we could just pass the filename around in change
   events, and querying the metadata for that file would be quick.
   
         

*/



// TODO
// fix edit mode

/*
 * This app displays photos and videos that are stored on the phone.
 *
 * Its starts with a thumbnail view in which small versions of all photos
 * and videos are displayed.  Tapping on a thumbnail shows the image
 * or video at the full size of the screen and swiping left or right moves to
 * the next or previous image or video.
 *
 * The app supports two-finger "pinch" gestures to zoom in and out on an
 * image.  When zoomed, a one finger swipe gesture pans within the zoomed
 * image, and only moves to the next or previous image once you reach the
 * edge of the currently displayed image.
 *
 * To make transitions between photos smooth, the app preloads the next
 * and previous image or video and positions them off-screen to the right and
 * left of the currently displayed image.
 *
 * Image and videos are displayed in "frames" which are managed by
 * the Frame.js abstraction. A Frame object includes a video player UI
 * (from VideoPlayer.js) and also includes the code that manage zooming
 * and panning within an image.
 */

//
// Tuneable parameters
//

// Pan this % of width to transition from one item to the next
const TRANSITION_FRACTION = 0.25;

// This is the speed of our default transitions in pixels/ms.
// Swipe faster than this to transition faster. But we'll
// never go slower (except slide show transitions).
const TRANSITION_SPEED = 0.75;

// How many thumbnails are visible on the first page
const PAGE_SIZE = 15; 


function $(id) { return document.getElementById(id); }

// UI elements
var thumbnails = $('thumbnails');
var frames = $('frames');

// Only one of these three elements will be visible at a time
var thumbnailListView = $('thumbnail-list-view');
var thumbnailSelectView = $('thumbnail-select-view');
var fullscreenView = $('fullscreen-view');
var editView = $('edit-view');
var pickView = $('pick-view');
var cropView = $('crop-view');

// These are the top-level view objects.
// This array is used by setView()
var views = [
  thumbnailListView, thumbnailSelectView, fullscreenView, editView,
  pickView, cropView
];
var currentView;

var editOptionButtons =
  Array.slice($('edit-options').querySelectorAll('a.radio.button'), 0);

var editBgImageButtons =
  Array.slice($('edit-options').querySelectorAll('a.bgimage.button'), 0);

// These three objects are holders for the previous, current and next
// photos or videos to be displayed. They get swapped around and
// reused when we pan to the next or previous photo: next becomes
// current, current becomes previous etc.  See nextFile() and
// previousFile().  Note also that the Frame object is not a DOM
// element.  Use currentFrame.container to refer to the div
// element. The frame constructor creates an <img> element, a <video>
// element, and video player controls within the div, and you can refer to
// those as currentFrame.image and currentFrame.video.player and
// currentFrame.video.controls.

var previousFrame = new MediaFrame($('frame1'));
var currentFrame = new MediaFrame($('frame2'));
var nextFrame = new MediaFrame($('frame3'));

// When this variable is set to true, we ignore any user gestures
// so we don't try to pan or zoom during a frame transition.
var transitioning = false;

// This will be set to "ltr" or "rtl" when we get our localized event
var languageDirection;

var currentFileIndex = 0;       // What file is currently displayed

// In thumbnailSelectView, we allow the user to select thumbnails.
// These variables hold the names of the selected files, and map those
// names to the corresponding File objects
var selectedFileNames = [];
var selectedFileNamesToBlobs = {};

var visibilityMonitor;

// The localized event is the main entry point for the app.
// We don't do anything until we receive it.
window.addEventListener('localized', function showBody() {
  window.removeEventListener('localized', showBody);

  // Set the 'lang' and 'dir' attributes to <html> when the page is translated
  document.documentElement.lang = navigator.mozL10n.language.code;
  document.documentElement.dir = navigator.mozL10n.language.direction;

  // <body> children are hidden until the UI is translated
  document.body.classList.remove('hidden');
});

document.addEventListener('DOMContentLoaded', init);

var scanner;

function init() {
  scanner = new Scanner('Gallery', 1, scannerCallback, {
    pictures: {
      mimeTypes: ['image/jpeg', 'image/png'],
      metadataParser: metadataParsers.imageMetadataParser
    },
    videos: {
      directory: 'DCIM/',
      metadataParser: metadataParsers.videoMetadataParser
    }
  });

  // Clicking on the back button goes back to the thumbnail view
  $('fullscreen-back-button').onclick = setView.bind(null, thumbnailListView);

  // Clicking on the select button goes to thumbnail select mode
  $('thumbnails-select-button').onclick =
    setView.bind(null, thumbnailSelectView);

  // Clicking on the cancel button goes from thumbnail select mode
  // back to thumbnail list mode
  $('thumbnails-cancel-button').onclick = setView.bind(null, thumbnailListView);

  // Clicking on the pick back button cancels the pick activity.
  $('pick-back-button').onclick = cancelPick;

  // In crop view, the back button goes back to pick view
  $('crop-back-button').onclick = function() {
    setView(pickView);
    cleanupCrop();
  };

  // In crop view, the done button finishes the pick
  $('crop-done-button').onclick = finishPick;

  // The camera buttons should both launch the camera app
  $('fullscreen-camera-button').onclick = launchCameraApp;
  $('thumbnails-camera-button').onclick = launchCameraApp;

  // Clicking the delete button while viewing a single item deletes that item
  $('fullscreen-delete-button').onclick = deleteSingleItem;

  // Clicking on the delete button in thumbnail select mode deletes all
  // selected items
  $('thumbnails-delete-button').onclick = deleteSelectedItems;

  // Clicking the Edit button while viewing a photo switches to edit mode
  $('fullscreen-edit-button').onclick = function() {
    editPhotoIfCardNotFull(currentFileIndex);
  };

  // In fullscreen mode, the share button shares the current item
  $('fullscreen-share-button').onclick = shareSingleItem;

  // Clicking on the share button in select mode shares all selected images
  $('thumbnails-share-button').onclick = shareSelectedItems;

  // Handle resize events
  window.onresize = resizeHandler;

  // Edit mode event handlers
  $('edit-exposure-button').onclick = setEditTool.bind(null, 'exposure');
  $('edit-crop-button').onclick = setEditTool.bind(null, 'crop');
  $('edit-effect-button').onclick = setEditTool.bind(null, 'effect');
  $('edit-border-button').onclick = setEditTool.bind(null, 'border');
  $('edit-crop-none').onclick = undoCropHandler;
  $('edit-cancel-button').onclick = exitEditMode;
  $('edit-save-button').onclick = saveEditedImage;
  editOptionButtons.forEach(function(b) { b.onclick = editOptionsHandler; });

  // Use the GestureDetector.js library to handle gestures.
  // This will generate tap, pan, swipe and transform events
  new GestureDetector(frames).startDetecting();

  // Handle gesture events
  frames.addEventListener('tap', tapHandler);
  frames.addEventListener('dbltap', dblTapHandler);
  frames.addEventListener('pan', panHandler);
  frames.addEventListener('swipe', swipeHandler);
  frames.addEventListener('transform', transformHandler);

  // When displaying a photo or video, a tap hides or shows the toolbar.
  // The video player has its own toolbar, so when a video starts playing
  // we want to hide the gallery toolbar. And then restore it on pause.
  // All three players need this pair of event handlers.
  // Note that we're using the onplaying/onpaused fake handlers the
  // VideoPlayer object, not the real onplay/onpause handlers of the <video>
  // element. This is because VideoPlayer pauses and plays the <video> when
  // the user drags on the slider, and we don't want to trigger these handlers
  // in that case.
  currentFrame.video.onplaying =
    previousFrame.video.onplaying =
    nextFrame.video.onplaying =
    function hideToolbarOnPlay() {
      this.toolbarWasHidden =
        fullscreenView.classList.contains('toolbarhidden');
      if (!this.isToolbarHidden)
        fullscreenView.classList.add('toolbarhidden');
    };

  currentFrame.video.onpaused =
    previousFrame.video.onpaused =
    nextFrame.video.onpaused =
    function restoreToolbarOnPause() {
      if (this.toolbarWasHidden === false)
        fullscreenView.classList.remove('toolbarhidden');
      delete this.toolbarWasHidden;
    };

  // Each of the Frame container elements may be subject to animated
  // transitions. So give them transitionend event handlers that
  // remove the transition style property when the transition ends.
  // This helps prevent unexpected transitions.
  function removeTransition(event) {
    event.target.style.transition = null;
  }

  previousFrame.container.addEventListener('transitionend', removeTransition);
  currentFrame.container.addEventListener('transitionend', removeTransition);
  nextFrame.container.addEventListener('transitionend', removeTransition);

  setView(thumbnailListView);
//  initThumbnails();

/*
 * the rest of the function commented out for startup tests
 *
  // If we were not invoked by an activity, then start off in thumbnail
  // list mode, and fire up the image and video mediadb objects.
  if (!navigator.mozHasPendingMessage('activity')) {
    initDB(true);
    setView(thumbnailListView);
  }

  // Register a handler for activities. This will take care of the rest
  // of the initialization process.
  navigator.mozSetMessageHandler('activity', function activityHandler(a) {
    var activityName = a.source.name;
    switch (activityName) {
    case 'browse':
      // The 'browse' activity is the way we launch Gallery from Camera.
      // If this was a cold start, then the db needs to be initialized.
      if (!photodb)
        initDB(true);  // Initialize both the photo and video databases
      // Always switch to the list of thumbnails.
      setView(thumbnailListView);
      break;
    case 'pick':
      if (pendingPick) // I don't think this can really happen anymore
        cancelPick();
      if (!photodb)
        initDB(false); // Don't include videos when picking photos!
      startPick(a);
      break;
    }
  });
*/
}


//
// Enumerate existing entries in the photo and video databases in reverse
// chronological order (most recent first) and display thumbnails for them all.
// After the thumbnails are displayed, scan for new files.
//
// This function gets called when the app first starts up, and also
// when the sdcard becomes available again after a USB mass storage
// session or an sdcard replacement.
//
function initThumbnails() {
  console.startup("initThumbnails()");

  thumbnails.textContent = '';

  var firstpage = Math.min(PAGE_SIZE, scanner.files.length);
  
  // Fill in the first page, and explicitly set the background image
  // for these thumbnails so they appear as soon as possible.
  for(var i = 0; i < firstpage; i++) {
    var filename = scanner.files[i].name;
    var thumbnail = createThumbnail(filename);
    var url = scanner.thumbnails[filename];
    if (url)
      thumbnail.style.backgroundImage = 'url("' + url + '")';
    thumbnails.appendChild(thumbnail);
  }

  setTimeout(afterFirstPage);
}

function afterFirstPage() {
  console.startup("afterFirstPage()");

  // Keep track of when thumbnails are onscreen and offscreen
  if (!visibilityMonitor) {
    visibilityMonitor =
      monitorChildVisibility(thumbnails,
                             360,                 // extra space top and bottom
                             thumbnailOnscreen,   // set background image
                             thumbnailOffscreen); // remove background image
  }
  
  // Now that the thumbnails are created, we can start handling clicks
  thumbnails.onclick = thumbnailClickHandler;

  // now go and create the rest of the thumbnails if there are any
  for(var i = PAGE_SIZE; i < scanner.files.length; i++) {
    var filename = scanner.files[i].name;
    var thumbnail = createThumbnail(filename);
    thumbnails.appendChild(thumbnail);
  }

  scanner.scan();
}

function scannerCallback(type, detail, position) {
  switch(type) {
  case 'ready': // no args, scanner.files is initialized
    // Hide the nocard or pluggedin overlay if it is displayed
    if (currentOverlay === 'nocard' || currentOverlay === 'pluggedin')
      showOverlay(null);

    // We get this on startup and when sdcard state returns to available
    // Always rebuild thumbnails when this happens
    initThumbnails();
    break;

  case 'insert': // fileinfo, pos
    // We get these notifications when a new file is created or discovered
    // during scanning. They may not be in order
    thumbnails.insertBefore(createThumbnail(detail.name),
                            thumbnails.children[position]);

    if (currentOverlay === 'emptygallery')
      showOverlay(null);

    if (currentFileIndex >= position)
      currentFileIndex++;
    if (editedPhotoIndex >= position)
      editedPhotoIndex++;

    // Redisplay the current photo if we're in photo view. The current
    // photo should not change, but the content of the next or previous frame
    // might. This call will only make changes if the filename to display
    // in a frame has actually changed.
    if (currentView === fullscreenView) {
      showFile(currentFileIndex);
    }

    break;

  case 'delete': // fileinfo, pos
    // We get these notifications when a scan discovers a file has been deleted
    // or when we get a device storage event about a deleted file
    thumbnails.removeChild(thumbnails.children[position]);

    // Adjust currentFileIndex, too, if we have to.
    if (position < currentFileIndex)
      currentFileIndex--;

    // If we remove the last file
    // we need to show the previous image, not the next image.
    if (currentFileIndex >= scanner.files.length)
      currentFileIndex = scanner.files.length - 1;

    if (position < editedPhotoIndex)
      editedPhotoIndex--;

    // If we're in fullscreen mode, then the only way this function
    // gets called is when we delete the currently displayed photo. This means
    // that we need to redisplay.
    if (currentView === fullscreenView && scanner.files.length > 0) {
      showFile(currentFileIndex);
    }

    // If there are no more photos show the "no pix" overlay
    if (scanner.files.length === 0) {
      if (currentView !== pickView)
        setView(thumbnailListView);
      showOverlay('emptygallery');
    }

    break;

  case 'scanstart':
    // Show the scanning indicator
    $('progress').classList.remove('hidden');
    $('throbber').classList.add('throb');
    break;

  case 'scanend':
    // Hide the scanning indicator
    $('progress').classList.add('hidden');
    $('throbber').classList.remove('throb');
    if (scanner.files.length === 0)
      showOverlay('emptygallery');
    break;

  case 'unavailable': // state
    if (detail === Scanner.NOCARD)
      showOverlay('nocard');
    else if (detail === Scanner.UNMOUNTED)
      showOverlay('pluggedin');
    break;
  }
}

// Make the thumbnail for image n visible
function scrollToShowThumbnail(n) {
  var selector = 'li[data-index="' + n + '"]';
  var thumbnail = thumbnails.querySelector(selector);
  if (thumbnail) {
    var screenTop = thumbnails.scrollTop;
    var screenBottom = screenTop + thumbnails.clientHeight;
    var thumbnailTop = thumbnail.offsetTop;
    var thumbnailBottom = thumbnailTop + thumbnail.offsetHeight;
    var toolbarHeight = 40; // compute this dynamically?

    // Adjust the screen bottom up to be above the overlaid footer
    screenBottom -= toolbarHeight;

    if (thumbnailTop < screenTop) {            // If thumbnail is above screen
      thumbnails.scrollTop = thumbnailTop;     // scroll up to show it.
    }
    else if (thumbnailBottom > screenBottom) { // If thumbnail is below screen
      thumbnails.scrollTop =                   // scroll  down to show it
        thumbnailBottom - thumbnails.clientHeight + toolbarHeight;
    }
  }
}

function setView(view) {
  if (currentView === view)
    return;

  // Do any necessary cleanup of the view we're exiting
  switch (currentView) {
  case thumbnailSelectView:
    // Clear the selection, if there is one
    Array.forEach(thumbnails.querySelectorAll('.selected.thumbnail'),
                  function(elt) { elt.classList.remove('selected'); });
    break;
  case fullscreenView:
    // Clear the frames to release the memory they're holding and
    // so that we don't see a flash of the old image when we return
    // to fullscreen view
    previousFrame.clear();
    currentFrame.clear();
    nextFrame.clear();
    delete previousFrame.filename;
    delete currentFrame.filename;
    delete nextFrame.filename;

    // If we're leaving fullscreen, then we were just viewing a photo
    // or video, so make sure its thumbnail is fully on the screen.
    // XXX: do we need to defer this?
    scrollToShowThumbnail(currentFileIndex);

    break;
  }

  // Show the specified view, and hide the others
  for (var i = 0; i < views.length; i++) {
    if (views[i] === view)
      views[i].classList.remove('hidden');
    else
      views[i].classList.add('hidden');
  }

  // Now do setup for the view we're entering
  // In particular, we've got to set the thumbnail class appropriately
  // for each view
  switch (view) {
  case thumbnailListView:
    thumbnails.className = 'list';
    break;
  case thumbnailSelectView:
    thumbnails.className = 'select';
    // Set the view header to a localized string
    clearSelection();
    break;
  case pickView:
    thumbnails.className = 'pick';
    break;
  case fullscreenView:
    thumbnails.className = 'offscreen';
    // Show the toolbar
    fullscreenView.classList.remove('toolbarhidden');
    break;
  default:
    thumbnails.className = 'offscreen';
    break;
  }

  // Remember the current view
  currentView = view;
}

//
// Create a thumbnail element
//
function createThumbnail(filename) {
  var li = document.createElement('li');
  li.classList.add('thumbnail');
  li.dataset.filename = filename;
  return li;
}

// monitorChildVisibility() calls this when a thumbnail comes onscreen
function thumbnailOnscreen(thumbnail) {
  scanner.getThumbnailURL(thumbnail.dataset.filename, function(url) {
    if (!url) {
      console.warning('No thumbnail for ' + thumbnail.dataset.name);
      return;
    }

    thumbnail.style.backgroundImage = 'url("' + url + '")';
  });
}

// monitorChildVisibility() calls this when a thumbnail goes offscreen
function thumbnailOffscreen(thumbnail) {
  thumbnail.style.backgroundImage = null;
}

//
// Pick activity
//

var pendingPick;
var pickType;
var pickWidth, pickHeight;
var cropURL;
var cropEditor;

function startPick(activityRequest) {
  pendingPick = activityRequest;
  pickType = activityRequest.source.data.type;
  if (pendingPick.source.data.width && pendingPick.source.data.height) {
    pickWidth = pendingPick.source.data.width;
    pickHeight = pendingPick.source.data.height;
  }
  else {
    pickWidth = pickHeight = 0;
  }
  setView(pickView);
}

function cropPickedImage(fileinfo) {
  setView(cropView);

  scanner.getFile(fileinfo.name, function(file) {
    cropURL = URL.createObjectURL(file);
    cropEditor = new ImageEditor(cropURL, $('crop-frame'), {}, function() {
      cropEditor.showCropOverlay();
      if (pickWidth)
        cropEditor.setCropAspectRatio(pickWidth, pickHeight);
      else
        cropEditor.setCropAspectRatio(); // free form cropping
    });
  });
}

function finishPick() {
  cropEditor.getCroppedRegionBlob(pickType, pickWidth, pickHeight,
                                  function(blob) {
                                    pendingPick.postResult({
                                      type: pickType,
                                      blob: blob
                                    });
                                    cleanupPick();
                                  });
}

function cancelPick() {
  pendingPick.postError('pick cancelled');
  cleanupPick();
}

function cleanupCrop() {
  if (cropURL) {
    URL.revokeObjectURL(cropURL);
    cropURL = null;
  }
  if (cropEditor) {
    cropEditor.destroy();
    cropEditor = null;
  }
}

function cleanupPick() {
  cleanupCrop();
  pendingPick = null;
  setView(thumbnailListView);
}

// XXX If the user goes to the homescreen or switches to another app
// the pick request is implicitly cancelled
// Remove this code when https://github.com/mozilla-b2g/gaia/issues/2916
// is fixed and replace it with an onerror handler on the activity to
// switch out of pickView.
window.addEventListener('mozvisibilitychange', function() {
  if (document.mozHidden && pendingPick)
    cancelPick();
});


//
// Event handlers
//


// Clicking on a thumbnail does different things depending on the view.
// In thumbnail list mode, it displays the image. In thumbnailSelect mode
// it selects the image. In pick mode, it finishes the pick activity
// with the image filename
function thumbnailClickHandler(evt) {
  var target = evt.target;
  if (!target || !target.classList.contains('thumbnail'))
    return;

  if (currentView === thumbnailListView || currentView === fullscreenView) {
    var fileinfo = scanner.data[target.dataset.filename];
    var position = scanner.files.indexOf(fileinfo);
    showFile(position);
  }
  else if (currentView === thumbnailSelectView) {
    updateSelection(target);
  }
  else if (currentView === pickView) {
    cropPickedImage(scanner.data[target.dataset.filename]);
  }
}

function clearSelection() {
  selectedFileNames = [];
  selectedFileNamesToBlobs = {};
  $('thumbnails-delete-button').classList.add('disabled');
  $('thumbnails-share-button').classList.add('disabled');
  $('thumbnails-number-selected').textContent =
    navigator.mozL10n.get('number-selected2', { n: 0 });
}

// When we enter thumbnail selection mode, or when the selection changes
// we call this function to update the message the top of the screen and to
// enable or disable the Delete and Share buttons
function updateSelection(thumbnail) {
  // First, update the visual appearance of the element
  thumbnail.classList.toggle('selected');

  // Now update the list of selected filenames and filename->blob map
  // based on whether we selected or deselected the thumbnail
  var selected = thumbnail.classList.contains('selected');
  var filename = thumbnail.dataset.filename;

  if (selected) {
    selectedFileNames.push(filename);
    scanner.getFile(filename, function(file) {
      selectedFileNamesToBlobs[filename] = file;
    });
  }
  else {
    delete selectedFileNamesToBlobs[filename];
    var i = selectedFileNames.indexOf(filename);
    if (i !== -1)
      selectedFileNames.splice(i, 1);
  }

  // Now update the UI based on the number of selected thumbnails
  var numSelected = selectedFileNames.length;
  var msg = navigator.mozL10n.get('number-selected2', { n: numSelected });
  $('thumbnails-number-selected').textContent = msg;

  if (numSelected === 0) {
    $('thumbnails-delete-button').classList.add('disabled');
    $('thumbnails-share-button').classList.add('disabled');
  }
  else {
    $('thumbnails-delete-button').classList.remove('disabled');
    $('thumbnails-share-button').classList.remove('disabled');
  }
}

function launchCameraApp() {
  var a = new MozActivity({
    name: 'record',
    data: {
      type: 'photos'
    }
  });
}

function deleteSelectedItems() {
  var selected = thumbnails.querySelectorAll('.selected.thumbnail');
  if (selected.length === 0)
    return;

  var msg = navigator.mozL10n.get('delete-n-items?', {n: selected.length});
  if (confirm(msg)) {
    for (var i = 0; i < selected.length; i++) {
      selected[i].classList.toggle('selected');
      scanner.deleteFile(selected[i].dataset.filename);
    }
    clearSelection();
  }
}

// Clicking the delete button while viewing a single item deletes that item
function deleteSingleItem() {
  var fileinfo = scanner.files[currentFileIndex];
  var msg;
  if (fileinfo.kind === 'videos') {
    msg = navigator.mozL10n.get('delete-video?');
  }
  else {
    msg = navigator.mozL10n.get('delete-photo?');
  }
  if (confirm(msg)) {
    scanner.deleteFile(fileinfo.name);
  }
}

// In fullscreen mode, the share button shares the current item
function shareSingleItem() {
  share([currentFrame.blob]);
}

// Clicking on the share button in select mode shares all selected images
function shareSelectedItems() {
  var blobs = selectedFileNames.map(function(name) {
    return selectedFileNamesToBlobs[name];
  });
  share(blobs);
}

function share(blobs) {
  if (blobs.length === 0)
    return;

  var names = [], types = [], fullpaths = [];

  // Get the file name (minus path) and type of each blob
  blobs.forEach(function(blob) {
    // Discard the path, we just want the base name
    var name = blob.name;
    // We try to fix Bug 814323 by using
    // current workaround of bluetooth transfer
    // so we will pass both filenames and fullpaths
    // The fullpaths can be removed after Bug 811615 is fixed
    fullpaths.push(name);
    name = name.substring(name.lastIndexOf('/') + 1);
    names.push(name);

    // And we just want the first component of the type "image" or "video"
    var type = blob.type;
    if (type)
      type = type.substring(0, type.indexOf('/'));
    types.push(type);
  });

  // If there is just one type, or if all types are the same, then use
  // that type plus '/*'. Otherwise, use 'multipart/mixed'
  // If all the blobs are image we use 'image/*'. If all are videos
  // we use 'video/*'. Otherwise, 'multipart/mixed'.
  var type;
  if (types.length === 1 || types.every(function(t) { return t === types[0]; }))
    type = types[0] + '/*';
  else
    type = 'multipart/mixed';

  var a = new MozActivity({
    name: 'share',
    data: {
      type: type,
      number: blobs.length,
      blobs: blobs,
      filenames: names,
      filepaths: fullpaths
    }
  });

  a.onerror = function(e) {
    if (a.error.name === 'NO_PROVIDER') {
      var msg = navigator.mozL10n.get('share-noprovider');
      alert(msg);
    }
    else {
      console.warn('share activity error:', a.error.name);
    }
  };
}

// This happens when the user rotates the phone.
// When we used mozRequestFullscreen, it would also happen
// when we entered or left fullscreen mode.
function resizeHandler() {
  //
  // When we enter or leave fullscreen mode, we get two resize events.
  // When we get the first one, we don't know what our new size is, so
  // we just ignore it. XXX: we're not using fullscreen mode anymore,
  // but it seems safer to leave this code in.
  //
  if (fullscreenView.offsetWidth === 0 && fullscreenView.offsetHeight === 0)
    return;

  if (currentView === fullscreenView) {
    currentFrame.resize();
    previousFrame.reset();
    nextFrame.reset();

    // We also have to reposition the frames to get the next and previous
    // frames the correct distance away from the current frame
    setFramesPosition();
  }
}

// In order to distinguish single taps from double taps, we have to
// wait after a tap arrives to make sure that a dbltap event isn't
// coming soon.
var taptimer = null;
function tapHandler(e) {
  // If there is already a timer set, then this is is the second tap
  // and we're about to get a dbl tap event, so ignore this one
  if (taptimer)
    return;
  // If we don't get a second tap soon, then treat this as a single tap
  taptimer = setTimeout(function() {
    taptimer = null;
    singletap(e);
  }, GestureDetector.DOUBLE_TAP_TIME);
}

// Dispatch double tap events, but only when displaying a photo
function dblTapHandler(e) {
  if (currentFrame.displayingVideo)
    return;

  clearTimeout(taptimer);
  taptimer = null;
  doubletapOnPhoto(e);
}

function singletap(e) {
  if (currentView === fullscreenView) {
    if (currentFrame.displayingImage || currentFrame.video.player.paused) {
      fullscreenView.classList.toggle('toolbarhidden');
    }
  }
}

// Quick zoom in and out with dbltap events
function doubletapOnPhoto(e) {
  var scale;
  if (currentFrame.fit.scale > currentFrame.fit.baseScale)   // If zoomed in
    scale = currentFrame.fit.baseScale / currentFrame.fit.scale; // zoom out
  else                                                       // Otherwise
    scale = 2;                                                   // zoom in

  currentFrame.zoom(scale, e.detail.clientX, e.detail.clientY, 200);
}

// Pan the item sideways when the user moves their finger across the screen
function panHandler(event) {
  if (transitioning)
    return;

  var dx = event.detail.relative.dx;
  var dy = event.detail.relative.dy;
  var oldFrameOffset = frameOffset;

  // If the frames are already being shifted in the same direction as
  // dx then this just continues the shift.  Otherwise, dx might shift
  // them back toward the center. If the frames are unshifted to begin
  // with or become unshifted after applying dx, then we have got to
  // pass dx to the pan() method of the frame, because it might pan
  // the image within the frame. But that method returns any dx it
  // can't use, and we apply that to shifting the frames.

  // If the frames are already shifted and dx is in the same direction, or
  // if dx is in the opposite direction but isn't big enough to bring
  // the frames back to the center, just adjust the frame positions.
  // There is no need to pan the content of the frame in this case.
  if ((frameOffset > 0 && dx > 0) ||
      (frameOffset < 0 && dx < 0) ||
      (frameOffset !== 0 && frameOffset > -dx)) {
    frameOffset += dx;
  }
  else {
    // If the frame is shifted, this dx brings it back to center
    if (frameOffset !== 0) {
      dx += frameOffset;
      frameOffset = 0;
    }

    // Now let the frame pan its content, and add any dx that it doesn't use
    // to the frame offset
    frameOffset += currentFrame.pan(dx, dy);
  }

  // Don't swipe past the end of the last item or past the start of the first
  if ((currentFileIndex === 0 && frameOffset > 0) ||
      (currentFileIndex === scanner.files.length - 1 && frameOffset < 0)) {
    frameOffset = 0;
  }

  // If the frameOffset has changed since we started, reposition the frames
  if (frameOffset !== oldFrameOffset)
    setFramesPosition();
}

// When the user lifts their finger after panning we get this event
function swipeHandler(event) {
  // If we just panned within a zoomed-in photo, and the frames are not
  // shifted at all, then we don't have to do anything here.
  if (frameOffset === 0)
    return;

  // 1 means we're going to the next item -1 means the previous
  var direction = (frameOffset < 0) ? 1 : -1;

  // If we're in a right-to-left locale, reverse those directions
  if (languageDirection === 'rtl')
    direction *= -1;

  // Did we pan far enough or swipe fast enough to transition to
  // a different item?
  var farenough =
    Math.abs(frameOffset) > window.innerWidth * TRANSITION_FRACTION;
  var velocity = event.detail.vx;
  var fastenough = Math.abs(velocity) > TRANSITION_SPEED;

  // Make sure that that the speed and pan amount are in the same direction
  var samedirection = velocity === 0 || frameOffset / velocity >= 0;

  // Is there a next or previous item to transition to?
  var fileexists =
    (direction === 1 && currentFileIndex + 1 < scanner.files.length) ||
    (direction === -1 && currentFileIndex > 0);

  // If all of these conditions hold, then we'll transition to the
  // next photo or the previous photo
  if (direction !== 0 && (farenough || fastenough) &&
      samedirection && fileexists) {

    // Compute how long the transition should take based on the velocity
    var speed = Math.max(Math.abs(velocity), TRANSITION_SPEED);
    var time = (window.innerWidth - Math.abs(frameOffset)) / speed;

    // Transition frames in the appropriate direction
    if (direction === 1)
      nextFile(time);
    else
      previousFile(time);
  }
  else if (frameOffset !== 0) {
    // Otherwise, just restore the current item by undoing
    // the translations we added during panning
    var time = Math.abs(frameOffset) / TRANSITION_SPEED;

    currentFrame.container.style.transition =
      nextFrame.container.style.transition =
      previousFrame.container.style.transition =
      'transform ' + time + 'ms ease';

    resetFramesPosition();

    // Ignore  pan and zoom gestures while the transition happens
    transitioning = true;
    setTimeout(function() { transitioning = false; }, time);
  }
}

// We also support pinch-to-zoom
function transformHandler(e) {
  if (transitioning)
    return;

  currentFrame.zoom(e.detail.relative.scale,
                    e.detail.midpoint.clientX,
                    e.detail.midpoint.clientY);
}

// A utility function to display the nth image or video in the specified frame
// Used in showFile(), nextFile() and previousFile().
function setupFrameContent(n, frame) {
  // Make sure n is in range
  if (n < 0 || n >= scanner.files.length) {
    frame.clear();
    delete frame.filename;
    return;
  }

  var fileinfo = scanner.files[n];

  // If we're already displaying this file in this frame, then do nothing
  if (fileinfo.name === frame.filename)
    return;

  // Remember what file we're going to display
  frame.filename = fileinfo.name;

  scanner.getFile(fileinfo.name, function(file) {
    if (fileinfo.kind === 'videos') {
      frame.displayVideo(file,
                         fileinfo.metadata.width,
                         fileinfo.metadata.height,
                         fileinfo.metadata.rotation || 0);
    }
    else {
      frame.displayImage(file,
                         fileinfo.metadata.width,
                         fileinfo.metadata.height,
                         fileinfo.metadata.preview);
    }
  });
}

var FRAME_BORDER_WIDTH = 3;
var frameOffset = 0; // how far are the frames swiped side-to-side?

function setFramesPosition() {
  // XXX for RTL languages we should swap next and previous sides
  var width = window.innerWidth + FRAME_BORDER_WIDTH;
  currentFrame.container.style.transform =
    'translateX(' + frameOffset + 'px)';
  nextFrame.container.style.transform =
    'translateX(' + (frameOffset + width) + 'px)';
  previousFrame.container.style.transform =
    'translateX(' + (frameOffset - width) + 'px)';
}

function resetFramesPosition() {
  frameOffset = 0;
  setFramesPosition();
}

// Switch from thumbnail list view to single-picture fullscreen view
// and display the specified file
function showFile(n) {
  setView(fullscreenView); // Switch to fullscreen mode if not already there

  setupFrameContent(n - 1, previousFrame);
  setupFrameContent(n, currentFrame);
  setupFrameContent(n + 1, nextFrame);
  currentFileIndex = n;

  resetFramesPosition();

  // Disable the edit button if this is a video, and enable otherwise
  if (scanner.files[n].metadata.kind === 'videos')
    $('fullscreen-edit-button').classList.add('disabled');
  else
    $('fullscreen-edit-button').classList.remove('disabled');
}

// Transition to the next file, animating it over the specified time (ms).
// This is used when the user pans.
function nextFile(time) {
  // If already displaying the last one, do nothing.
  if (currentFileIndex === scanner.files.length - 1)
    return;

  // Don't pan a playing video!
  if (currentFrame.displayingVideo && !currentFrame.video.player.paused)
    currentFrame.video.pause();

  // Set a flag to ignore pan and zoom gestures during the transition.
  transitioning = true;
  setTimeout(function() { transitioning = false; }, time);

  // Set transitions for the visible frames
  var transition = 'transform ' + time + 'ms ease';
  currentFrame.container.style.transition = transition;
  nextFrame.container.style.transition = transition;

  // Cycle the three frames so next becomes current,
  // current becomes previous, and previous becomes next.
  var tmp = previousFrame;
  previousFrame = currentFrame;
  currentFrame = nextFrame;
  nextFrame = tmp;
  currentFileIndex++;

  // Move (transition) the frames to their new position
  resetFramesPosition();

  // Update the frame for the new next item
  setupFrameContent(currentFileIndex + 1, nextFrame);

  // When the transition is done, cleanup
  currentFrame.container.addEventListener('transitionend', function done(e) {
    this.removeEventListener('transitionend', done);

    // Reposition the item that just transitioned off the screen
    // to reset any zooming and panning
    previousFrame.reset();
  });

  // Disable the edit button if we're now viewing a video, and enable otherwise
  if (currentFrame.displayingVideo)
    $('fullscreen-edit-button').classList.add('disabled');
  else
    $('fullscreen-edit-button').classList.remove('disabled');
}

// Just like nextFile() but in the other direction
function previousFile(time) {
  // if already displaying the first one, do nothing.
  if (currentFileIndex === 0)
    return;

  // Don't pan a playing video!
  if (currentFrame.displayingVideo && !currentFrame.video.player.paused)
    currentFrame.video.pause();

  // Set a flag to ignore pan and zoom gestures during the transition.
  transitioning = true;
  setTimeout(function() { transitioning = false; }, time);

  // Set transitions for the visible frames
  var transition = 'transform ' + time + 'ms ease';
  previousFrame.container.style.transition = transition;
  currentFrame.container.style.transition = transition;

  // Transition to the previous item: previous becomes current, current
  // becomes next, etc.
  var tmp = nextFrame;
  nextFrame = currentFrame;
  currentFrame = previousFrame;
  previousFrame = tmp;
  currentFileIndex--;

  // Move (transition) the frames to their new position
  resetFramesPosition();

  // Preload the new previous item
  setupFrameContent(currentFileIndex - 1, previousFrame);

  // When the transition is done do some cleanup
  currentFrame.container.addEventListener('transitionend', function done(e) {
    this.removeEventListener('transitionend', done);
    // Reset the size and position of the item that just panned off
    nextFrame.reset();
  });

  // Disable the edit button if we're now viewing a video, and enable otherwise
  if (currentFrame.displayingVideo)
    $('fullscreen-edit-button').classList.add('disabled');
  else
    $('fullscreen-edit-button').classList.remove('disabled');
}

var editedPhotoIndex;
var editedPhotoURL; // The blob URL of the photo we're currently editing
var editSettings;
var imageEditor;

// Ensure there is enough space to store an edited copy of photo n
// and if there is, call editPhoto to do so
function editPhotoIfCardNotFull(n) {
  var fileinfo = scanner.files[n];
  var imagesize = fileinfo.size;

  scanner.freeSpace(function(freespace) {
    // the edited image might take up more space on the disk, but
    // not all that much more
    if (freespace > imagesize * 2) {
      editPhoto(n);
    }
    else {
      alert(navigator.mozL10n.get('memorycardfull'));
    }
  });
}

function editPhoto(n) {
  editedPhotoIndex = n;

  // Start with no edits
  editSettings = {
    crop: {
      x: 0, y: 0,
      w: scanner.files[n].metadata.width, h: scanner.files[n].metadata.height
    },
    gamma: 1,
    borderWidth: 0,
    borderColor: [0, 0, 0, 0]
  };

  // Start looking up the image file
  scanner.getFile(scanner.files[n].name, function(file) {
    // Once we get the file create a URL for it and use that url for the
    // preview image and all the buttons that need it.
    editedPhotoURL = URL.createObjectURL(file);

    // Create the image editor object
    // This has to come after setView or the canvas size is wrong.
    imageEditor = new ImageEditor(editedPhotoURL,
                                  $('edit-preview-area'),
                                  editSettings);

    // Configure the exposure tool as the first one shown
    setEditTool('exposure');

    // Set the exposure slider to its default value
    exposureSlider.setExposure(0);

    // Set the background for all of the image buttons
    var backgroundImage = 'url(' + editedPhotoURL + ')';
    editBgImageButtons.forEach(function(b) {
      b.style.backgroundImage = backgroundImage;
    });
  });

  // Display the edit screen
  setView(editView);

  // Set the default option buttons to correspond to those edits
  editOptionButtons.forEach(function(b) { b.classList.remove('selected'); });
  $('edit-crop-aspect-free').classList.add('selected');
  $('edit-effect-none').classList.add('selected');
  $('edit-border-none').classList.add('selected');
}

// Crop, Effect and border buttons call this
function editOptionsHandler() {
  // First, unhighlight all buttons in this group and then
  // highlight the button that has just been chosen. These
  // buttons have radio behavior
  var parent = this.parentNode;
  var buttons = parent.querySelectorAll('a.radio.button');
  Array.forEach(buttons, function(b) { b.classList.remove('selected'); });
  this.classList.add('selected');

  if (this === $('edit-crop-aspect-free'))
    imageEditor.setCropAspectRatio();
  else if (this === $('edit-crop-aspect-portrait'))
    imageEditor.setCropAspectRatio(2, 3);
  else if (this === $('edit-crop-aspect-landscape'))
    imageEditor.setCropAspectRatio(3, 2);
  else if (this === $('edit-crop-aspect-square'))
    imageEditor.setCropAspectRatio(1, 1);
  else if (this.dataset.effect) {
    editSettings.matrix = ImageProcessor[this.dataset.effect + '_matrix'];
    imageEditor.edit();
  }
  else {
    if (this.dataset.borderWidth) {
      editSettings.borderWidth = parseFloat(this.dataset.borderWidth);
    }
    if (this.dataset.borderColor === 'white') {
      editSettings.borderColor = [1, 1, 1, 1];
    }
    else if (this.dataset.borderColor === 'black') {
      editSettings.borderColor = [0, 0, 0, 1];
    }
    imageEditor.edit();
  }
}

/*
 * This is the exposure slider component for edit mode.  This ought to be
 * converted into a reusable slider module, but for now this is a
 * custom version that hardcodes things like the -3 to +3 range of values.
 */
var exposureSlider = (function() {
  var slider = document.getElementById('exposure-slider');
  var bar = document.getElementById('sliderbar');
  var thumb = document.getElementById('sliderthumb');

  thumb.addEventListener('mousedown', sliderStartDrag);

  var currentExposure;
  var sliderStartPixel;
  var sliderStartExposure;

  function sliderStartDrag(e) {
    document.addEventListener('mousemove', sliderDrag, true);
    document.addEventListener('mouseup', sliderEndDrag, true);
    sliderStartPixel = e.clientX;
    sliderStartExposure = currentExposure;
    e.preventDefault();
  }

  function sliderDrag(e) {
    var delta = e.clientX - sliderStartPixel;
    var exposureDelta = delta / (parseInt(bar.clientWidth) * .8) * 6;
    var oldExposure = currentExposure;
    setExposure(sliderStartExposure + exposureDelta);
    if (currentExposure !== oldExposure)
      slider.dispatchEvent(new Event('change', {bubbles: true}));
    e.preventDefault();
  }

  function sliderEndDrag(e) {
    document.removeEventListener('mousemove', sliderDrag, true);
    document.removeEventListener('mouseup', sliderEndDrag, true);
    e.preventDefault();
  }

  // Set the thumb position between -3 and +3
  function setExposure(exposure) {
    // Make sure it is not out of bounds
    if (exposure < -3)
      exposure = -3;
    else if (exposure > 3)
      exposure = 3;

    // Round to the closest .25
    exposure = Math.round(exposure * 4) / 4;

    if (exposure === currentExposure)
      return;

    var barWidth = parseInt(bar.clientWidth);
    var thumbWidth = parseInt(thumb.clientWidth);

    // Remember the new exposure value
    currentExposure = exposure;

    // Convert exposure value to % position of thumb center
    var percent = 10 + (exposure + 3) * 80 / 6;

    // Convert percent to pixel position of thumb center
    var pixel = barWidth * percent / 100;

    // Compute pixel position of left edge of thumb
    pixel -= thumbWidth / 2;

    // Move the thumb to that position
    thumb.style.left = pixel + 'px';

    // Display exposure value in thumb
    thumb.textContent = exposure;
  }

  return {
    setExposure: setExposure,
    getExposure: function() { return currentExposure; }
  };
}());

$('exposure-slider').onchange = function() {
  var stops = exposureSlider.getExposure();

  // Convert the exposure compensation stops gamma correction value.
  var factor = -1;  // XXX: adjust this factor to get something reasonable.
  var gamma = Math.pow(2, stops * factor);
  editSettings.gamma = gamma;
  imageEditor.edit();
};

function setEditTool(tool) {
  // Deselect all tool buttons and hide all options
  var buttons = $('edit-toolbar').querySelectorAll('a.button');
  Array.forEach(buttons, function(b) { b.classList.remove('selected'); });
  var options = $('edit-options').querySelectorAll('div.edit-options-bar');
  Array.forEach(options, function(o) { o.classList.add('hidden'); });

  // If we were in crop mode, perform the crop and then
  // exit crop mode. If the user tapped the Crop button then we'll go
  // right back into crop mode, but this means that the Crop button both
  // acts as a mode switch button and a "do the crop now" button.
  imageEditor.cropImage();
  imageEditor.hideCropOverlay();

  // Now select and show the correct set based on tool
  switch (tool) {
  case 'exposure':
    $('edit-exposure-button').classList.add('selected');
    $('exposure-slider').classList.remove('hidden');
    break;
  case 'crop':
    $('edit-crop-button').classList.add('selected');
    $('edit-crop-options').classList.remove('hidden');
    imageEditor.showCropOverlay();
    break;
  case 'effect':
    $('edit-effect-button').classList.add('selected');
    $('edit-effect-options').classList.remove('hidden');
    break;
  case 'border':
    $('edit-border-button').classList.add('selected');
    $('edit-border-options').classList.remove('hidden');
    break;
  }
}

function undoCropHandler() {
  // Switch to free-form cropping
  Array.forEach($('edit-crop-options').querySelectorAll('a.radio.button'),
                function(b) { b.classList.remove('selected'); });
  $('edit-crop-aspect-free').classList.add('selected');
  imageEditor.setCropAspectRatio(); // freeform

  // And revert to full-size image
  imageEditor.undoCrop();
}

function exitEditMode(saved) {
  // Revoke the blob URL we've been using
  URL.revokeObjectURL(editedPhotoURL);
  editedPhotoURL = null;

  // close the editor object
  imageEditor.destroy();
  imageEditor = null;

  // We came in to edit mode from fullscreenView.  If the user cancels the edit
  // go back to fullscreenView.  Otherwise, if the user saves the photo, we go
  // back to thumbnail list view because that is where the newly saved
  // image is going to show up.
  // XXX: this isn't really right. Ideally the new photo should show up
  // right next to the old one and we should go back to fullscreenView to view
  // the edited photo.
  if (saved) {
    currentFileIndex = 0; // because the saved image will be newest
    setView(thumbnailListView);
  }
  else
    setView(fullscreenView);
}

// When the user clicks the save button, we produce a full-size version
// of the edited image, save it into the media database and return to
// photo view mode.
// XXX: figure out what the image number of the edited photo is or will be
// and return to viewing that one.  Ideally, edited photos would be grouped
// with the original, rather than by date, but I'm not sure I can
// do that sort order.  Ideally, I'd like the mediadb to not generate a
// change event when we manually add something to it or at least have that
// option
function saveEditedImage() {
  // If we are in crop mode, perform the crop before saving
  if ($('edit-crop-button').classList.contains('selected'))
    imageEditor.cropImage();

  imageEditor.getFullSizeBlob('image/jpeg', function(blob) {

    var original = scanner.files[editedPhotoIndex].name;
    var basename, extension, filename;
    var version = 1;
    var p = original.lastIndexOf('.');
    if (p === -1) {
      basename = original;
      extension = '';
    }
    else {
      basename = original.substring(0, p);
      extension = original.substring(p);
    }

    // Create a filename for the edited image.  Loop if necessary and
    // increment the version number until we find a version a name that
    // is not in use.
    // XXX: this loop is O(n^2) and slow if the user saves many edits
    // of the same image.
    filename = basename + '.edit' + version + extension;
    while (scanner.files.some(function(i) { return i.name === filename; })) {
      version++;
      filename = basename + '.edit' + version + extension;
    }

    // Now that we have a filename, save the file This will send a
    // change event, which will cause us to rebuild our thumbnails.
    // For now, the edited image will become the first thumbnail since
    // it si the most recent one. Ideally, I'd like a more
    // sophisticated sort order that put edited sets of photos next to
    // each other.
    scanner.addFile('pictures', filename, blob);

    // We're done.
    exitEditMode(true);
  });
}

//
// Overlay messages
//
var currentOverlay;  // The id of the current overlay or null if none.

//
// If id is null then hide the overlay. Otherwise, look up the localized
// text for the specified id and display the overlay with that text.
// Supported ids include:
//
//   nocard: no sdcard is installed in the phone
//   pluggedin: the sdcard is being used by USB mass storage
//   emptygallery: no pictures found
//
// Localization is done using the specified id with "-title" and "-text"
// suffixes.
//
function showOverlay(id) {
  currentOverlay = id;

  if (id === null) {
    $('overlay').classList.add('hidden');
    return;
  }

  $('overlay-title').textContent = navigator.mozL10n.get(id + '2-title');
  $('overlay-text').textContent = navigator.mozL10n.get(id + '2-text');
  $('overlay').classList.remove('hidden');
}

// XXX
// Until https://bugzilla.mozilla.org/show_bug.cgi?id=795399 is fixed,
// we have to add a dummy click event handler on the overlay in order to
// make it opaque to touch events. Without this, it does not prevent
// the user from interacting with the UI.
$('overlay').addEventListener('click', function dummyHandler() {});
