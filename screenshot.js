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
  page.settings.userAgent = 'Windows / Chrome 34: Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/34.0.1847.137 Safari/537.36';
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