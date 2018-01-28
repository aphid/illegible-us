var fs = require('fs');
var settings = fs.read("settings.json");
settings = JSON.parse(settings);

var url = phantom.args[0];
//url = "https://www.senate.gov/isvp/?type=arch&comm=intel&filename=intel051117&auto_play=true&poster=http://www.intelligence.senate.gov/sites/default/files/video-poster-flash-fit.jpg";
var filename = new URL(url).searchParams.get('filename');
var resp = {};
var dir;
if (settings.mode == "dev") {
    dir = settings.devPaths.webshotDir;
} else {
    dir = settings.livePaths.webshotDir;
}
var uA = settings.userAgents[Math.floor(Math.random() * settings.userAgents.length)];

var start = new Date().getTime() / 1000;
var done = false;
var page = require('webpage').create();
var HDS = function (url) {
    var start = new Date().getTime() / 1000;
    //nothing is true, everything is false! ok, but we need autoplay to be true.
    url = url.replace("'", "").replace("false", "true");
    return new Promise(function (resolve) {
        var data = {};
        page.settings.userAgent = uA;
        page.open(url, function (status) { // executed after loading
            if (page.content.includes("Access")) {
                page.render(dir + filename + ".denied.png");
                done = true;
                response = {
                    status: "denied",
                    filename: filename + ".denied.png"
                };

                console.log(JSON.stringify(response));
                slimer.exit();
            }
        }).then(function () {
            if (page.content.includes("Access Denied")) {
                done = true;
                page.render(dir + filename + ".denied.png");

                response = {
                    status: "denied",
                    filename: filename + ".denied.png"
                };
                //data.content = page.content;
                //console.log('{"status": "denied"}');
                console.log(JSON.stringify(response));
                slimer.exit();
            }
        });
        page.onResourceReceived = function (response) {
            //console.log(response.url);
            var current = new Date().getTime() / 1000;
            if (current - start > 40 && resp.status !== "fail") {
                resp.status = "fail";
                done = true;
                console.log(JSON.stringify(resp));
                slimer.exit();
            }
            if (response.url.includes('mp4?v') && response.status === 200) {
                data.type = "mp4";
                done = true;
                data.src = response.url;
                page.close();
                resolve(data);
		slimer.exit();
            } else if (response.url.includes('m3u') && response.status === 200) {
                data.type = "m3u";
                done = true;
                data.src = response.url;
                page.close();
                resolve(data);
		slimer.exit();
            }
            /*
            } else if (response.url.includes('flv')) {
		                    data.type = "flv";
		                    data.src = response.url;
		                    page.close();
		                    resolve(data);
	     }*/
            if (response.status === 200 && (response.url.includes('manifest')) && (!response.url.includes('gif'))) {
                //console.log(">>>>>>>>>>  " + response.status);
                url = response.url;
                //console.log(url);
                data.type = "hds";
                done = true;
                data.manifest = url;
            }
            if (response.status === 200 && response.url.includes('Frag')) {
                data.auth = response.url.split('?').pop();

            }
            if (data.auth && data.manifest) {
                page.close();
                resolve(data);
            }
        };
    });

};
HDS(url).then(function (resolve) {
    console.log(JSON.stringify(resolve));
    slimer.exit();
}).catch(function (reason) {
    console.log(JSON.stringify(reason));
    slimer.exit();
});
slimer.wait(45000);
if (!done) {
    console.log('{"status": "fail"}');
}
slimer.exit();
