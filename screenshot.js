var url = phantom.args[0];
var dir = "/var/www/illegible.us/html/ssci/images/";
var filename = phantom.args[1];
var userAgents = ['Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.80 Safari/537.36', 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36', 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:42.0) Gecko/20100101 Firefox/42.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) AppleWebKit/601.3.9 (KHTML, like Gecko) Version/9.0.2 Safari/601.3.9', 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36'];
var uA = userAgents[Math.floor(Math.random() * userAgents.length)];
var page;
var errors = [];
var response;

requestPage = function () {
    page.settings.userAgent = uA;
    page.viewportSize = {
        width: 1270,
        height: 1116
    };
    page.open(url, function (status) { // executed after 
        if (status !== "success" && status[0] !== 'success') {
            console.log('{"status": "failure"}');
            slimer.exit();
        }
    }).then(function () {
        if (page.content.includes("Denied")) {

            page.render(dir + filename + ".denied.png");

            response = {
                status: "denied",
                filename: filename + ".denied.png"
            };
            //data.content = page.content;
            //console.log('{"status": "denied"}');
            console.log(JSON.stringify(response));
            slimer.exit();

        } else {

            page.render(dir + filename + ".jpg", { format: "jpeg", quality: 25});
            response = {
                status: "success",
                filename: filename + ".jpg"
            };
            response.errors = errors;
            console.log(JSON.stringify(response))
            slimer.exit();
        }
    });
};

if (!url || !filename) {
    console.log('{"status": "failed"}');
    slimer.exit();
} else {
    page = require('webpage').create();

    var target = dir + filename + ".png";
    requestPage();
}

page.onError = function (message, line, file) {
    var error = {
        "status": "error",
        "message": message,
        "line": line,
        "file": file
    };
    errors.push(error);

};


if (!String.prototype.includes) {
    String.prototype.includes = function () {
        'use strict';
        return String.prototype.indexOf.apply(this, arguments) !== -1;
    };
}
