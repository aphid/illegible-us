var url = phantom.args[0];
var dir = "/var/www/html/webshots/";
var filename = phantom.args[1];

if (!url || !filename) {
  console.log("no url or filename");
  slimer.exit();
} else {

  var target = dir + filename + ".png";

  console.log("writing to " + target);

  var page = require('webpage').create();
  page.settings.userAgent = 'Mozilla / 5.0(compatible; MSIE 10.0; Windows NT 6.1; Trident / 6.0';
  page.viewportSize = {
    width: 1270,
    height: 1116
  };
  page.open(url, function () { // executed after 
    page.render(dir + filename + ".png");

  }).then(function () {
    slimer.exit();
  });
}