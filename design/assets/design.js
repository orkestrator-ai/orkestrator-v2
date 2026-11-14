// Marks missing before/after images and shows how many of the required images exist.
(function () {
  var frames = Array.prototype.slice.call(document.querySelectorAll(".frame"));
  var badge = document.querySelector("[data-evidence-badge]");
  function update() {
    if (!badge) return;
    var total = frames.length;
    var missing = frames.filter(function (f) {
      return f.classList.contains("missing");
    }).length;
    var settled = frames.every(function (f) {
      return f.dataset.settled === "1";
    });
    if (!settled) return;
    var have = total - missing;
    badge.textContent = "Evidence " + have + " / " + total + " images";
    badge.dataset.complete = String(total > 0 && missing === 0);
  }
  frames.forEach(function (frame) {
    var img = frame.querySelector("img");
    if (!img) return;
    function settle(ok) {
      frame.classList.toggle("missing", !ok);
      frame.dataset.settled = "1";
      update();
    }
    if (img.complete) settle(img.naturalWidth > 0);
    else {
      img.addEventListener("load", function () {
        settle(true);
      });
      img.addEventListener("error", function () {
        settle(false);
      });
    }
  });
})();
