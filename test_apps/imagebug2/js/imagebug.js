var IMAGE_WIDTH = 512;  // this is the size of the camera thumbnails
var IMAGE_HEIGHT = 384;
var NUM_IMAGES = 25;

window.onload = function() {
  var container = document.getElementById("thumbnails");

  // Use a canvas as a source of images
  var canvas = document.createElement('canvas');
  canvas.width = IMAGE_HEIGHT;
  canvas.height = IMAGE_WIDTH;
  var context = canvas.getContext('2d');
  context.fillStyle = 'red';
  context.fillRect(100, 100, 200, 100);

  var n = 0; 

  addThumbnail();

  function addThumbnail() {
    canvas.toBlob(function(blob) {
      displayThumbnail(blob);
      if (++n < NUM_IMAGES)
        addThumbnail();
    }, "image/jpeg")
  }

  function displayThumbnail(blob) {
    var li = document.createElement('li');
    li.classList.add('thumbnail');
    var url = URL.createObjectURL(blob);
    li.style.backgroundImage = 'url("' + url + '")';
    container.appendChild(li);
  }
}