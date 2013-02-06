// This script kicks off the gallery initialization process. It does
// the bare minimum of stuff that needs to happen before the document
// and other scripts load.

// XXX:
// Need to check activities here. If we're doing a pick
// then we need to init the scanner differently

var scanner = new Scanner('Gallery', 1, {
  pictures: {
    mimeTypes: ['image/jpeg', 'image/png'],
    metadataParser: metadataParsers.imageMetadataParser
  },
  videos: {
    directory: 'DCIM/',
    metadataParser: metadataParsers.videoMetadataParser
  }
});