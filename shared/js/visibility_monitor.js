/*
 * visibility_monitor.js
 *
 * Given a scrolling element (with overflow-y: scroll set,
 * e.g.), monitorChildVisibility() listens for scroll events in order to
 * determine which descendant elements are visible within the element and
 * which are not (assuming that the scrolling element itself is visible).
 *
 * When a descendant scrolls onscreen, it is passed to the onscreen callback.
 *
 * When a descendant scrolls offscreen, it is passed to the offscreen callback.
 *
 * This class also listens for DOM modification events so that it can handle
 * descendants being added to or removed from the scrolling element. It also
 * handles resize events.
 *
 * When you insert a new descendant into the scrolling element, you should
 * create it in its offscreen state. If it is inserted offscreen nothing
 * will happen. If you insert it onscreen, it will immediately be passed
 * to the onscreen callback function
 *
 * The scrollmargin argument specifies a number of pixels. Elements
 * that are within this many pixels of being onscreen are considered
 * onscreen.
 *
 * The scrolldelta parameter is also a number of pixels.  The user
 * must scroll this distance before any visibility recomputation is
 * done by this code.  This parameter can be used to "batch" up work
 * into larger chunks.
 *
 * By specifing proper onscreen and offscreen functions you can use this
 * class to (for example) remove the background-image style of elements
 * that are not visible, allowing gecko to free up image memory.
 * In that sense, this class can be used to workaround
 * https://bugzilla.mozilla.org/show_bug.cgi?id=689623
 *
 * The childType argument specifies the HTML tagname of the elements to
 * be monitored. It is optional, if omitted, all elements (other than
 * those with of containerType) will be monitored.
 *
 * The containerType argument specifies the HTML tagname of container
 * elements whose children are to be monitored. If this argument is
 * omitted, then only direct children of the scrolling element will be
 * monitored. If specified, then children of containers of the specified
 * type that are children of the scrolling element will be monitored.
 * (XXX: do we allow arbitrary nesting of containers, or only grandchildren?)
 *
 * The return value of this function is an object that has a stop() method.
 * calling the stop method stops visiblity monitoring. If you want to restart
 * call monitorChildVisiblity() again.
 *
 * monitorChildVisiblity() makes the following assumptions. If your program
 * violates them, the function may not work correctly:
 *
 *  Descendants of the scrolling element flow left to right and top to
 *  bottom. I.e. if descendant2 comes after descendant1 in document order,
 *  then descendant2 has a clientTop value that is greater than or equal to
 *  the clientTop of descendant1.
 *
 *  Descendants are not absolutely positioned and JavaScript is never used
 *  to alter their position.
 *
 *  Descendants don't change size, either spontaneously or in response to
 *  onscreen and offscreen callbacks. Don't set display:none on an element
 *  when it goes offscreen, for example.
 *
 *  Descendants aren't added or removed to the scrolling element while the
 *  it or any of its ancestors is hidden with display:none or is removed
 *  from the tree. The mutation observer that responds to additions and
 *  deletions needs the scrolling element and its descendants to have valid
 *  layout data in order to figure out what is onscreen and what is
 *  offscreen. Use visiblity:hidden instead of display:none if you need to
 *  add or remove children while the scrolling element is hidden.
 *
 *  DocumentFragments are not used to add multiple descendants at once to
 *  the scrolling element, and multiple descendants are not deleted at once by
 *  setting innerHTML or innerText to ''.
 *
 *  The scrolling element only changes size when there is a resize event
 *  on the window.
 */
'use strict';

function monitorChildVisibility(scrollingElement,
                                scrollmargin, scrolldelta,
                                onscreenCallback, offscreenCallback,
                                childType, containerType)
{
  childType = childType ? childType.toUpperCase() : null;
  containerType = containerType ? containerType.toUpperCase() : null;

  // The onscreen region is represented by these two elements
  var firstOnscreen = null, lastOnscreen = null;

  // This is the last onscreen region that we have notified the client about
  var firstNotifiedOnscreen = null, lastNotifiedOnscreen = null;

  // The scrolling element's scrollTop when we last recomputed visibility.
  var lastScrollTop = -1;

  // Update the onscreen region whenever we scroll
  scrollingElement.addEventListener('scroll', scrollHandler);

  // Update the onscreen region when the window changes size
  window.addEventListener('resize', resizeHandler);

  // Update the onscreen region when children are added or removed
  // XXX: either update this to monitor the entire subtree, or update
  // the handler to add a new observer for each container child
  // This depends on containerType, of course.
  var observer = new MutationObserver(mutationHandler);
  observer.observe(scrollingElement, { childList: true });

  // Now determine the initial onscreen region
  adjustBounds();

  // Call the onscreenCallback for the initial onscreen elements
  callCallbacks();

  // Return an object that allows the caller to stop monitoring
  return {
    stop: function stop() {
      // Unregister our event handlers and stop the mutation observer.
      scrollingElement.removeEventListener('scroll', scrollHandler);
      window.removeEventListener('resize', resizeHandler);
      observer.disconnect();
      // XXX: are there other observers for containers?
    }
  };

  // Adjust the onscreen element range and synchronously call onscreen
  // and offscreen callbacks as needed.
  function resizeHandler() {
    // If we are triggered with 0 height, ignore the event. If this happens
    // we don't have any layout data and we'll end up thinking that all
    // of the children are onscreen.  Better to do nothing at all here and
    // just wait until the scrolling element becomes visible again.
    if (scrollingElement.clientHeight === 0) {
      return;
    }
    adjustBounds();
    callCallbacks();
  }

  // Called when children are added or removed from the scrolling element.
  // Adding and removing nodes can change the position of other elements
  // so changes may extend beyond just the ones added or removed
  function mutationHandler(mutations) {
    // Ignore any mutations while we are not displayed because
    // none of our calculations will be right
    if (scrollingElement.clientHeight === 0) {
      return;
    }

    // XXX:
    // If there is a container type, see if we've added a container
    // and start observing that?
    // I need to see what happens when adding a container that already
    // has kids. I think I need to assume that adding or removing a
    // container changes the layout and needs adjustBounds, etc.
    // Can I use one observer with multiple calls to observe on different
    // elements?

    for (var i = 0; i < mutations.length; i++) {
      var mutation = mutations[i];
      if (mutation.addedNodes) {
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var child = mutation.addedNodes[j];
          // XXX: add test for childType here
          // XXX: also handle new container insertion?
          if (child.nodeType === Node.ELEMENT_NODE)
            childAdded(child);
        }
      }

      if (mutation.removedNodes) {
        for (var j = 0; j < mutation.removedNodes.length; j++) {
          var child = mutation.removedNodes[j];
          // XXX: add test for childType here
          // XXX: also handle new container insertion?
          if (child.nodeType === Node.ELEMENT_NODE)
            childRemoved(child,
                         mutation.previousSibling,
                         mutation.nextSibling);
        }
      }
    }
  }

  // If the new child is onscreen, call the onscreen callback for it.
  // Adjust the onscreen element range and synchronously call
  // onscreen and offscreen callbacks as needed.
  function childAdded(child) {
    // If the added child is after the last onscreen child, and we're
    // not filling in the first page of content then this insertion
    // doesn't affect us at all.
    if (lastOnscreen &&
        after(child, lastOnscreen) &&
        child.offsetTop > scrollingElement.clientHeight + scrollmargin)
      return;

    // Otherwise, if this is the first element added or if it is after
    // the first onscreen element, then it is onscreen and we need to
    // call the onscreen callback for it.
    if (!firstOnscreen || after(child, firstOnscreen)) {
      // Invoke the onscreen callback for this child
      try {
        onscreenCallback(child);
      }
      catch (e) {
        console.warn('monitorChildVisibility: Exception in onscreenCallback:',
                     e, e.stack);
      }
    }

    // Now adjust the first and last onscreen element and
    // send a synchronous notification
    adjustBounds();
    callCallbacks();
  }

  // If the removed element was after the last onscreen element just return.
  // Otherwise adjust the onscreen element range and synchronously call
  // onscreen and offscreen callbacks as needed. Note, however that there
  // are some special cases when the last element is deleted or when the
  // first or last onscreen element is deleted.
  function childRemoved(child, previous, next) {
    // If there aren't any elements left revert back to initial state
    if (firstElement() === null) {
      firstOnscreen = lastOnscreen = null;
      firstNotifiedOnscreen = lastNotifiedOnscreen = null;
    }
    else {
      // If the removed child was after the last onscreen child, then
      // this removal doesn't affect us at all.
      if (previous !== null && after(previous, lastOnscreen))
        return;

      // If the first onscreen element was the one removed
      // use the next or previous element as a starting point instead.
      // We know that there is at least one element left, so one of these
      // two must be defined.
      //
      // XXX: I can't assume that the next and previous values from the
      // mutation record are elements of the right type. And if they are
      // null there may still be elements in an adjacent container.  So
      // this algorithm breaks in this generalized case. If we're just
      // observing the childList of a container, then we can use the target
      // to find the container, and can optimize based on that, I think.  I
      // wonder if adjust bounds will do the right thing if I just set
      // firstOnScreen and/or lastOnScreen to null?  I don't think that
      // we need to be super efficient for this deletion case.
      if (child === firstOnscreen) {
        firstOnscreen = firstNotifiedOnscreen = next || previous;
      }

      // And similarly for the last onscreen element
      if (child === lastOnscreen) {
        lastOnscreen = lastNotifiedOnscreen = previous || next;
      }

      // Find the new bounds after the deletion
      adjustBounds();
    }

    // Synchronously call the callbacks
    callCallbacks();
  }

  // Adjust the onscreen element range and call onscreen and offscreen
  // callbacks if we've scrolled more than scrolldelta pixels.
  function scrollHandler() {
    // Ignore scrolls while we are not displayed because
    // none of our calculations will be right
    if (scrollingElement.clientHeight === 0) {
      return;
    }

    // Adjust the first and last onscreen element if we've panned
    // beyond the scrolldelta margin.
    var scrollTop = scrollingElement.scrollTop;
    if (Math.abs(scrollTop - lastScrollTop) < scrolldelta) {
      return;
    }

    lastScrollTop = scrollTop;

    adjustBounds();
    callCallbacks();
  }

  // Return true if node a is before node b and false otherwise
  function before(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // Return true if node a is after node b and false otherwise
  function after(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  // This function recomputes the range of onscreen elements. Normally it
  // just needs to do small amounts of nextElementSibling
  // or previousElementSibling iteration to find the range. But it can also
  // start from an unknown state and search the entire scrolling element to
  // find the range of child elements that are onscreen.
  function adjustBounds() {
    var firstElement = firstElement();
    // If the scrolling element has no children, the bounds are null
    if (firstElement === null) {
      firstOnscreen = lastOnscreen = null;
      return;
    }

    // Compute the visible region of the screen, including scroll margin
    var scrollTop = scrollingElement.scrollTop;
    var screenTop = scrollTop - scrollmargin;
    var screenBottom = scrollTop + scrollingElement.clientHeight + scrollmargin;

    // This utility function returns ON if the child is onscreen,
    // BEFORE if it offscreen before the visible elements and AFTER if
    // it is offscreen aafter the visible elements
    var BEFORE = -1, ON = 0, AFTER = 1;
    function position(child) {
      var childTop = child.offsetTop;
      var childBottom = childTop + child.offsetHeight;
      if (childBottom < screenTop)
        return BEFORE;
      if (childTop > screenBottom)
        return AFTER;
      return ON;
    }

    // If we don't have a first onscreen element yet, start with the first.
    if (!firstOnscreen)
      firstOnscreen = firstElement;

    // Check the position of the top
    var toppos = position(firstOnscreen);

    // If the first element is onscreen, see if there are earlier ones
    if (toppos === ON) {
      var prev = previousSibling(firstOnscreen);
      while (prev && position(prev) === ON) {
        firstOnscreen = prev;
        prev = previousSibling(prev);
      }
    }
    else if (toppos === BEFORE) {
      // The screen is below us, so find the next element that is visible.
      var e = nextSibling(firstOnscreen);
      while (e && position(e) !== ON) {
        e = nextSibling(e);
      }
      firstOnscreen = e;
    }
    else {
      // We've scrolled a lot or things have moved so much that the
      // entire visible region is now above the first element.
      // So scan backwards to find the new lastOnscreen and firstOnscreen
      // elements.  Note that if we get here, we can return since we
      // will have updated both bounds

      // Loop until we find an onscreen element
      lastOnscreen = previousSibling(firstOnscreen);
      while (lastOnscreen && position(lastOnscreen) !== ON)
        lastOnscreen = previousSibling(lastOnscreen);

      // Now loop from there to find the first onscreen element
      firstOnscreen = lastOnscreen;
      prev = previousSibling(firstOnscreen);
      while (prev && position(prev) === ON) {
        firstOnscreen = prev;
        prev = previousSibling(prev);
      }
      return;
    }

    // Now make the same adjustment on the bottom of the onscreen region
    // If we don't have a lastOnscreen value to start with, use the newly
    // computed firstOnscreen value.
    if (lastOnscreen === null)
      lastOnscreen = firstOnscreen;

    var bottompos = position(lastOnscreen);
    if (bottompos === ON) {
      // If the last element is onscreen, see if there are more below it.
      var next = nextSibling(lastOnscreen);
      while (next && position(next) === ON) {
        lastOnscreen = next;
        next = nextSibling(next);
      }
    }
    else if (bottompos === AFTER) {
      // the last element is now below the visible part of the screen
      lastOnscreen = lastOnscreen.previousElementSibling;
      while (position(lastOnscreen) !== ON)
        lastOnscreen = lastOnscreen.previousElementSibling;
    }
    else {
      // First and last are now both above the visible portion of the screen
      // So loop down to find their new positions
      firstOnscreen = nextSibling(lastOnscreen);
      while (firstOnscreen && position(firstOnscreen) !== ON) {
        firstOnscreen = nextSibling(firstOnscreen);
      }

      lastOnscreen = firstOnscreen;
      var next = nextSibling(lastOnscreen);
      while (next && position(next) === ON) {
        lastOnscreen = next;
        next = nextSibling(next);
      }
    }
  }

  // Synchronously call the callbacks to notify the client of the new set
  // of onscreen elements. This only calls the onscreen and offscreen
  // callbacks for elements that have come onscreen or gone offscreen since
  // the last time it was called.
  function callCallbacks() {
    // Call the onscreen callback for element from and its siblings
    // up to, but not including to.
    function onscreen(from, to) {
      var e = from;
      while (e && e !== to) {
        try {
          onscreenCallback(e);
        }
        catch (ex) {
          console.warn('monitorChildVisibility: Exception in onscreenCallback:',
                       ex, ex.stack);
        }
        e = nextSibling(e);
      }
    }

    // Call the offscreen callback for element from and its siblings
    // up to, but not including to.
    function offscreen(from, to) {
      var e = from;
      while (e && e !== to) {
        try {
          offscreenCallback(e);
        }
        catch (ex) {
          console.warn('monitorChildVisibility: ' +
                       'Exception in offscreenCallback:',
                       ex, ex.stack);
        }
        e = nextSibling(e);
      }
    }

    // If the two ranges are the same, return immediately
    if (firstOnscreen === firstNotifiedOnscreen &&
        lastOnscreen === lastNotifiedOnscreen)
      return;

    // If the last notified range is null, then we just add the new range
    if (firstNotifiedOnscreen === null) {
      onscreen(firstOnscreen, lastOnscreen.nextElementSibling);
    }

    // If the new range is null, this means elements have been removed.
    // We don't need to call offscreen for elements that are not in the
    // scrolling element anymore, so we don't do anything in this case
    else if (firstOnscreen === null) {
      // Nothing to do here
    }

    // If the new range and the old range are disjoint, call the onscreen
    // callback for the new range first and then call the offscreen callback
    // for the old.
    else if (before(lastOnscreen, firstNotifiedOnscreen) ||
             after(firstOnscreen, lastNotifiedOnscreen)) {
      // Mark the new ones onscreen
      onscreen(firstOnscreen, lastOnscreen.nextElementSibling);

      // Mark the old range offscreen
      offscreen(firstNotifiedOnscreen,
                lastNotifiedOnscreen.nextElementSibling);
    }

    // Otherwise if new elements are visible at the top, call those callbacks
    // If new elements are visible at the bottom, call those.
    // If elements have gone offscreen at the top, call those callbacks
    // If elements have gone offscreen at the bottom, call those.
    else {
      // Are there new onscreen elements at the top?
      if (before(firstOnscreen, firstNotifiedOnscreen)) {
        onscreen(firstOnscreen, firstNotifiedOnscreen);
      }

      // Are there new onscreen elements at the bottom?
      if (after(lastOnscreen, lastNotifiedOnscreen)) {
        onscreen(lastNotifiedOnscreen.nextElementSibling,
                 lastOnscreen.nextElementSibling);
      }

      // Have elements gone offscreen at the top?
      if (after(firstOnscreen, firstNotifiedOnscreen)) {
        offscreen(firstNotifiedOnscreen, firstOnscreen);
      }

      // Have elements gone offscreen at the bottom?
      if (before(lastOnscreen, lastNotifiedOnscreen)) {
        offscreen(lastOnscreen.nextElementSibling,
                  lastNotifiedOnscreen.nextElementSibling);
      }
    }

    // Now the notified onscreen range is in sync with the actual
    // onscreen range.
    firstNotifiedOnscreen = firstOnscreen;
    lastNotifiedOnscreen = lastOnscreen;
  }

  // Generalized versions of firstElementChild, nextElementSibling and
  // previousElementSibling that work for children or grandchildren
  var firstElement, nextSibling, previousSibling;

  if (!containerType && !childType) {
    firstElement = function() { return scrollingElement.firstElementChild; };
    nextSibling = function(e) { return e.nextElementSibling; };
    previousSibling = function(e) { return e.previousElementSibling; };
  }
  else {
    (function() {
      function firstValid(child) {
        while(child) {
          if (!childType || child.tagName === childType)
            return child;
          child = child.nextElementSibling;
        }
        return null;
      }

      function firstChildAfter(container) {
        while(container) {
          if (!containerType || container.tagName === containerType) {
            child = firstValid(container.firstElementChild);
            if (child)
              return child;
          }
          container = container.nextElementSibling;
        }
        return null;
      }


      firstElement = function firstElement() {
        return firstChildAfter(scrollingElement.firstElementChild);
      };

      nextSibling = function nextSibling(e) {
        var next = firstValid(e.nextElementSibling);
        if (next)
          return next;

        // We've reached the end of this container, so find the first
        // child of the next container
        var container = e.parentElement;
        return firstChildAfter(container.nextElementSibling);
      };

      previousSibling = function previousSibling(e) {
        var prev = e.prevElementSibling;
        while(prev) {
          if (!childType || prev.tagName === childType)
            return prev;
          prev = prev.prevElementSibling;
        }
        // We've reached the beginining of this container
        var container = e.parentElement.prevElementSibling;
        while(container) {
          if (!containerType || container.tagname === containerType) {
            prev = container.lastElementChild;
            while(prev) {
              if (!childType || prev.tagname === childType)
                return prev;
              prev = prev.previousElementSibling;
            }
          }
        }
        return null;
      }
    }());
  }
}
