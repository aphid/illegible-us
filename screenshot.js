var fs = require('fs');
var url = phantom.args[0];
var settings = fs.read("settings.json");
var dir;
settings = JSON.parse(settings);
if (settings.mode == "dev") {
    dir = settings.devPaths.webshotDir;
} else {
    dir = settings.livePaths.webshotDir;
}
var filename = phantom.args[1];
var uA = settings.userAgents[Math.floor(Math.random() * settings.userAgents.length)];
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

            page.render(dir + filename + ".jpg", {
                format: "jpeg",
                quality: 25
            });
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
