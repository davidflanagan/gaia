(function() {

  var start = performance.timing.navigationStart;

  function time(msg) {
    console.log('Startup ' + (Date.now() - start) + ' ' + msg + '\n');
  }

  function timeEvent(target, type) {
    target.addEventListener(type, function() {
      time(type + ' event fired');
    });
  }

  timeEvent(document, 'DOMContentLoaded');
  timeEvent(window, 'load');
  timeEvent(window, 'localized');

  var observer = new MutationObserver(observeHead);
  observer.observe(document.head, { childList: true });

  function observeHead(mutations) {
    mutations.forEach(function(mutation) {
      var added = mutation.addedNodes;
      if (!added) 
        return;
      for(var i = 0; i < added.length; i++) 
        observe(added[i]);

      function observe(newnode) {
        if (newnode instanceof HTMLLinkElement && newnode.rel === 'stylesheet')
          time("inserted stylesheet <link>" + newnode.href);
        else if (newnode instanceof HTMLScriptElement) {
          time("inserted <script> " + newnode.src);
          newnode.addEventListener('load', function() {
            time("loaded script " + newnode.src);
          });
        }
      }
    });
  }
  
  console.startup = time;
}());