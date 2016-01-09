var url = phantom.args[0];
var dir = "/var/www/html/webshots/";
var filename = phantom.args[1];
var userAgents = ['Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.80 Safari/537.36', 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36', 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:42.0) Gecko/20100101 Firefox/42.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) AppleWebKit/601.3.9 (KHTML, like Gecko) Version/9.0.2 Safari/601.3.9', 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36'];
var uA = userAgents[Math.floor(Math.random() * userAgents.length)];



requestPage = function () {
  var page = require('webpage').create();
  page.settings.userAgent = uA;
  page.viewportSize = {
    width: 1270,
    height: 1116
  };
  page.open(url, function (status) { // executed after 
    if (status !== "success") {
      slimer.exit();
    }
    slimer.wait(1500);
    if (page.content.includes("Denied")) {
      page.close();

      slimer.wait(5000);
      console.log('{"status": "denied"}');
      slimer.exit();

    }
  }).then(function () {
    page.render(dir + filename + ".png");
    console.log('{"status": "success"}');

    slimer.exit();
  });
};



if (!url || !filename) {
  console.log("no url or filename");
  slimer.exit();
} else {

  var target = dir + filename + ".png";

  requestPage();
}

if (!String.prototype.includes) {
  String.prototype.includes = function () {
    'use strict';
    return String.prototype.indexOf.apply(this, arguments) !== -1;
  };
}