'use strict';

window.onload = function() {
  window.addEventListener('devicemotion', motion);
};


const screamThreshold = 2;
const stepThreshold = 2;

var steps = 0;

var previousMin = 20;
var previousMax = 0;
var screaming = false;
var scream = new Audio();
scream.src = 'resources/sounds/scream.wav';

// last value and the one before that
var m1 = 0, m2 = 0;

function motion(event) {
  var x = event.accelerationIncludingGravity.x;
  var y = event.accelerationIncludingGravity.y;
  var z = event.accelerationIncludingGravity.z;

  // Overall magnitude of the acceleration
  var m0 = Math.sqrt(x*x + y*y + z*z);

  if (m0 < screamThreshold) {
    scream.play();
    screaming = true;
  }
  else if (screaming) {
    screaming = false;
    scream.pause();
    scream.currentTime = 0;
  }



  // Have we reached a maximum?
  if (m1 > m0 && m1 > m2) {
    previousMax = m1;
    if (previousMax - previousMin > stepThreshold) {
      step();  // increment step count
    }
  }

  // Have we reached a minimum?
  if (m1 < m0 && m1 < m2) {
    previousMin = m1;
  }

  // rotate the saved values
  m2 = m1;
  m1 = m0;
}

function step() {
  steps++;

  document.getElementById('steps').textContent = steps;
}
