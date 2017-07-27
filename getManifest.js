var url = phantom.args[0];
url = "https://www.senate.gov/isvp/?type=arch&comm=intel&filename=intel051117&auto_play=true&poster=http://www.intelligence.senate.gov/sites/default/files/video-poster-flash-fit.jpg";
var resp = {};
var page = require('webpage').create();
var HDS = function (url) {
    var start = new Date().getTime() / 1000;
    //nothing is true, everything is false! ok, but we need autoplay to be true.
    url = url.replace("'", "").replace("false", "true");
    return new Promise(function (resolve) {
        var data = {};
        page.settings.userAgent = 'Windows / Chrome 34: Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/34.0.1847.137 Safari/537.36';
        page.open(url, function () { // executed after loading
            //console.log("<<<<<<");
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

            }
        });
        page.onResourceReceived = function (response) {
            //console.log(response.url);
            var current = new Date().getTime() / 1000;
            if (current - start > 45) {
                resp.status = "fail";
                console.log(JSON.stringify(resp));
                slimer.exit();
            }

            if (response.url.includes('flv')) {
                data.type = "flv";
                data.src = response.url;
                page.close();
                resolve(data);
            } else if (response.url.includes('mp4?v') && response.status === 200) {
                data.type = "mp4";
                data.src = response.url;
                page.close();
                resolve(data);
            } else if (response.url.includes('m3u8') && response.status === 200) {
		data.type = "m3u";
		data.src = response.url;
		page.close();
		resolve(data);

            }
            if (response.status === 200 && (response.url.includes('manifest')) && (!response.url.includes('gif'))) {
                //console.log(">>>>>>>>>>  " + response.status);
                url = response.url;
                //console.log(url);
                data.type = "hds";
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
