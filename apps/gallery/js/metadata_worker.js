function log(msg) {
  postMessage({log:msg});
}

importScripts('blobviewsync.js',
              'jpeg_metadata_parser.js',
              'get_video_rotation.js');

this.onmessage = function onmessage(e) {
  try {
    var file = e.data.file;
    var type = e.data.type;
    if (type === 'jpeg') {
      parseJPEGMetadata(file, 
                        function(metadata) { postMessage(metadata); },
                        function(errmsg) { postMessage(errmsg); });
    }
    else if (type === 'video') {
      getVideoRotation(file, function(rotation) { postMessage(rotation); });
    }
  }
  catch(e) {
    log("onmessage: " + e);
  }
};
