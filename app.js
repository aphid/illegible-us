/*jslint node: true */
/*jshint -W105 */
/*global require, module, Promise */

"use strict";

var request = require('request');
var cheerio = require('cheerio');
var moment = require('moment');
var Url = require('url');
var fs = require('graceful-fs');
var pfs = require('fs-promise');
var path = require('path');
var exif = require('exiftool');
var pdftotext = require('pdftotextjs');
var http = require('http');
var cpp = require('child-process-promise');
var ffmpeg = require('fluent-ffmpeg');
var Agent = require('socks5-http-client/lib/Agent');
var glob = require("glob");
var r = require("rethinkdb");

var scraper = {
    secure: false,
    //privkey: fs.readFileSync('./privkey.pem'),
    //cert: fs.readFileSync('./cert.pem'),
    torPass: fs.readFileSync('torpass.txt', 'utf8'),
    torPort: 9051,

    dataDir: './data/',
    hearingDir: './data/hearings/',
    textDir: './media/text/',
    mediaDir: './media/',
    incomingDir: './media/incoming/',
    metaDir: './media/metadata/',
    videoDir: './media/video/',
    transcodedDir: './media/transcoded/',
    webshotDir: '/var/www/html/oversee/images/',
    tempDir: "./media/temp/",
    busy: false,
    connections: 0,
    slimerFlags: " --proxy-type=socks5 --proxy=localhost:9050 ",
    started: false,
    blocked: false,
    sockets: 5,
    current: 0,
    rdbConn: null,
    rDb: {
        host: 'localhost',
        port: 28015,
        db: 'unrInt'
    },
    userAgents: ['Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.80 Safari/537.36', 'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36', 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:42.0) Gecko/20100101 Firefox/42.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_2) AppleWebKit/601.3.9 (KHTML, like Gecko) Version/9.0.2 Safari/601.3.9', 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/47.0.2526.106 Safari/537.36'],
};


if (scraper.secure) {
    var app = require('https').createServer({
        key: scraper.privkey,
        cert: scraper.cert
    });
} else {
    app = require('http').createServer();
}
app.listen(9080);

var io = require('socket.io')(app);

//paths should have trailing slash

scraper.msg = function (thing, kind) {
    console.log(thing);
    if (!kind) {
        kind = 'message';
    }

    if (typeof thing === "string") {
        io.to('oversight').emit(kind, thing);
    } else {
        io.to('oversight').emit(kind, JSON.stringify(thing));
    }
};

scraper.url = function (url) {
    console.log('sending url');
    console.log(JSON.stringify(url));
    io.to('oversight').emit('url', url);
};

scraper.cleanupFrags = async function () {
    var result = await glob("*Frag*", function (er, files) {
        if (files.length) {
            scraper.msg('deleting ' + files.length + ' temp fragments');
        }
        for (var file of files) {
            fs.unlinkSync(file);
        }
        if (fs.existsSync("Cookies.txt")) {
            fs.unlinkSync("Cookies.txt");
        }
        return Promise.resolve();
    });
    return result;
};

scraper.cleanupTemp = function () {
    var file;
    scraper.msg("CLEANING UP");
    var cwd = process.cwd();
    var files = fs.readdirSync(scraper.tempDir);
    if (files.length) {
        scraper.msg('deleting ' + files.length + ' files from temp');
    }
    for (file of files) {
        file = scraper.tempDir + file;
        if (file.includes('mp4') || file.includes('ogg') || file.includes('pdf')) {
            fs.unlinkSync(file);
        }
    }

    files = fs.readdirSync(scraper.incomingDir);
    if (files.length) {
        scraper.msg('deleting ' + files.length + ' files from incoming');
    }
    for (file of files) {
        file = scraper.incomingDir + file;
        if (file.includes('mp4') || file.includes('ogg') || file.includes('pdf')) {
            fs.unlinkSync(file);
        }
    }


    process.chdir(cwd);
    return Promise.resolve();
};

var Hearing = function (options) {
    this.video = {};
    this.witnesses = [];

    for (var fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }
    this.shortdate = moment(new Date(this.date)).format("YYMMDD");

};

var Video = function (options) {
    var fld;
    this.localPath = "";
    this.mp4 = "";
    this.ogg = "";
    for (fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }

    return this;
};


Video.prototype.getManifest = function () {

    scraper.msg("ADOBE HDS STREAM DETECTED");
    var vid = this;
    if (fs.existsSync(this.localPath)) {
        scraper.msg("nevermind, file already exists");
        return Promise.resolve();
    } else {
        scraper.msg("Getting remote info about " + vid.basename);
        scraper.msg("Requesting manifest and authentication key");
        return new Promise(function (fulfill, reject) {
            var url = "'" + vid.url + "'";
            url = url.replace('false', 'true');

            //INCOMPATIBLE WITH FRESHPLAYER PLUGIN
            var command = 'xvfb-run -a -e xv.log node_modules/slimerjs/src/slimerjs ' + scraper.slimerFlags + path.join(__dirname, 'getManifest.js') + " " + url + '| grep -v GraphicsCriticalError';
            console.log(command);
            //var command = 'slimerjs ' + path.join(__dirname, 'getManifest.js') + " " + url;
            scraper.msg(">>>> " + command.replace(__dirname, "."));

            cpp.exec(command).then(function (result) {
                    scraper.msg("Ignoring vector smash detection.");
                    //WHAT THE ACTUAL FUCK
                    var response = result.stdout.replace("Vector smash protection is enabled.", "");
                    scraper.msg(response);
                    response = JSON.parse(response);
                    if (response.status === 'denied') {
                        scraper.checkBlock().then(function () {
                            return vid.getManifest();
                        });
                    }
                    if (response.status === 'fail') {
                        console.log('manifest fail, retrying');
                        setTimeout(function () {
                            vid.getManifest();
                        }, 5000);

                    }
                    if (response.type) {
                        scraper.msg("Video type: " + vid.type);
                        vid.type = response.type;
                    }
                    scraper.msg("fulfilling manifest");

                    return fulfill(response);
                })
                .fail(function (err) {
                    console.error('ERROR: ', (err.stack || err));
                    reject(err);
                    console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!shutting down");
                    process.exit(1);
                })
                .progress(function (childProcess) {
                    scraper.msg('[exec] childProcess.pid: ', childProcess.pid);
                });

        });

    }


};


Video.prototype.fetch = function (data) {
    var vid = this,
        output, incoming;
    scraper.msg(data);
    if (!data.type) {
        return Promise.reject("Problem getting filetype");
    }
    if (fs.existsSync(scraper.videoDir + vid.basename + ".flv") || fs.existsSync(scraper.videoDir + vid.basename + ".mp4")) {
        return Promise.resolve();
    }
    return new Promise(function (fulfill, reject) {
        {
            scraper.msg("TYPE: " + data.type);
            if (data.type === 'flv' || data.type === 'mp4') {
                incoming = scraper.incomingDir + vid.basename + '.' + data.type;
                output = scraper.videoDir + vid.basename + '.' + data.type;

                scraper.msg("Will save to " + output);
                scraper.getFile(data.src, incoming).then(function () {
                    fs.renameSync(incoming, output);
                    vid.localPath = output;
                    return fulfill();
                });


            } else if (data.type === 'hds') {
                incoming = scraper.incomingDir + vid.basename + ".flv";
                output = scraper.videoDir + vid.basename + ".flv";
                //var command = 'php lib/AdobeHDS.php --manifest "' + data.manifest + '" --auth "' + data.auth + '" --outdir ' + scraper.incomingDir + ' --outfile ' + vid.basename;
                var childArgs = [
  path.join(__dirname, 'lib/AdobeHDS.php'), "--proxy", "socks5://localhost:9050", "--fproxy", "--manifest", data.manifest, "--auth", data.auth, '--outdir', scraper.incomingDir, '--outfile', vid.basename];
                scraper.msg('Requesting HDS fragments with credentials:');
                scraper.msg(' Authentication key: ' + data.auth);
                scraper.msg(' Manifest: ' + data.manifest);
                scraper.msg(childArgs);
                cpp.spawn("php", childArgs).fail(function (err) {
                        console.error('SPAWN ERROR: ', (err.stack || err));
                        reject(err);
                    })
                    .progress(function (childProcess) {
                        scraper.msg('[exec] childProcess.pid: ', childProcess.pid);
                        childProcess.stdout.on('data', function (data) {
                            scraper.msg('>>>>>>>> ' + data.toString().trim());
                        });
                        childProcess.stderr.on('data', function (data) {
                            scraper.msg('[spawn] stderr: ' + data.toString().trim());
                        });

                    }).then(function () {
                        fs.renameSync(incoming, output);
                        vid.localPath = output;
                        scraper.cleanupFrags();
                        scraper.cleanupTemp();

                    }).then(function () {
                        return fulfill();
                    });
            }

        }
    });
};

Video.prototype.transcodeToMP4 = function () {

    scraper.msg('TRANSCODING TO MP4');
    var vid = this,
        input, temp, output, acodec, vcodec, lpct = 0;


    return new Promise(function (fulfill, reject) {
        scraper.msg(vid);
        input = vid.localPath;
        //transcodes to temp dir rather than destination, copies when transcode is complete so we don't end up with phantom half-finshed files.
        temp = scraper.tempDir + vid.basename + '.mp4';
        output = scraper.transcodedDir + vid.basename + '.mp4';
        scraper.msg("transcoding " + input + " to " + output);
        if (fs.existsSync(output)) {
            scraper.msg("Video file already exists " + output);
            return fulfill();
        }
        scraper.msg(vid.type + " --> " + input);
        if (vid.type === 'hds') {
            scraper.msg("HDS");
            input = vid.localPath;
            acodec = 'copy';
            vcodec = 'copy';
        } else if (vid.type === 'flv') {
            scraper.msg("Ack, flv!");
            //real transcode, not remux
            acodec = 'aac';
            vcodec = 'libx264';
        } else if (vid.type === 'mp4') {
            acodec = 'aac';
            vcodec = 'libx264';
        } else if (vid.type === 'h264') {
            acodec = 'copy';
            vcodec = 'copy';
        } else {
            scraper.msg("I have no idea what I'm working with here.");
        }

        scraper.msg(acodec + " / " + vcodec);

        //var command = 'ffmpeg -i ' + vid.flv + ' -acodec copy -vcodec copy ' + vid.flv.replace('flv', 'mp4');
        ffmpeg(input)
            .output(temp)
            .audioCodec(acodec)
            .videoCodec(vcodec)
            .audioChannels(2)
            .on('start', function (commandLine) {
                scraper.msg('Spawned Ffmpeg with command: ' + commandLine);
            })
            .on('progress', function (progress) {
                var mf = Math.floor(progress.percent);

                if (mf > lpct) {
                    scraper.msg('Processing: ' + mf + '% done');
                    lpct = mf;

                }
            })
            .on('end', function () {
                //scraper.msg('Processing Finished');
                fs.renameSync(temp, output);
                return fulfill();
            })
            .on('error', function (err, stdout, stderr) {
                scraper.msg(err);
                scraper.msg(stderr);
                return reject(err);

            })
            .run();

    });

};






Video.prototype.transcodeToOgg = function () {
    scraper.msg('TRANSCODING TO OGG VORBIS AUDIO');
    var vid = this;
    var lpct = 0;

    return new Promise(function (fulfill, reject) {
        if (vid.type) {
            var input = vid.localPath;
            var temp = scraper.tempDir + vid.basename + ".ogg";
            var output = scraper.transcodedDir + vid.basename + ".ogg";
            if (fs.existsSync(output)) {
                scraper.msg("ogg already exists! " + output);
                return fulfill();
            }

            ffmpeg(input)
                .output(temp)
                .on('start', function (commandLine) {
                    scraper.msg('Spawned Ffmpeg with command: ' + commandLine);
                })
                .on('progress', function (progress) {
                    var mf = Math.floor(progress.percent);

                    if (mf > lpct) {
                        scraper.msg('Processing: ' + mf + '% done');
                        lpct = mf;

                    }
                })
                .audioCodec('libvorbis')
                .audioChannels(2)
                .noVideo()
                .on('end', function () {
                    scraper.msg('ogg end fired?');
                    scraper.msg('Processing Finished');
                    fs.renameSync(temp, output);
                    return fulfill();
                })
                .on('error', function (err, stdout, stderr) {
                    scraper.msg(err.message);
                    scraper.msg(stderr);
                    reject(err);
                })
                .run();

        }


    });
};


Video.prototype.transcodeToWebm = function () {
    scraper.msg('TRANSCODING TO WEBM (VP8/VORBIS)');
    var vid = this;
    var lpct = 0;

    return new Promise(function (fulfill, reject) {
        if (vid.type) {
            var input = vid.localPath;
            var temp = scraper.tempDir + vid.basename + ".webm";
            var output = scraper.transcodedDir + vid.basename + ".webm";
            if (fs.existsSync(output)) {
                scraper.msg("webm already exists! " + output);
                return fulfill();
            }

            ffmpeg(input)
                .output(temp)
                .on('start', function (commandLine) {
                    scraper.msg('Spawned Ffmpeg with command: ' + commandLine);
                })
                .on('progress', function (progress) {
                    var mf = Math.floor(progress.percent);

                    if (mf > lpct) {
                        scraper.msg('Processing: ' + mf + '% done');
                        lpct = mf;

                    }
                })
                .audioCodec('libvorbis')
                .audioChannels(2)
                .videoCodec('libvpx')
                .on('end', function () {
                    scraper.msg('webm end fired?');
                    scraper.msg('Processing Finished');
                    fs.renameSync(temp, output);
                    return fulfill();
                })
                .on('error', function (err, stdout, stderr) {
                    scraper.msg(err.message);
                    scraper.msg(stderr);
                    reject(err);
                })
                .run();

        }


    });
};


var Committee = function (options) {
    for (var fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }
    this.hearings = [];
    this.meta = [];
    return this;
};

var Witness = function (options) {
    for (var fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }
    if (!options.pdfs) {
        this.pdfs = [];
    }
};



Committee.prototype.addHearing = function (options) {
    options.baseUrl = this.url;
    var hearing = new Hearing(options);
    for (var hear of this.hearings) {
        if (hear.date === options.date) {
            scraper.msg("likely dupe");
            return false;
        }
    }
    this.hearings.push(hearing);
    scraper.hearing(hearing);
    return hearing;
};

scraper.hearing = function (hearing) {
    io.to('oversight').emit('hearing', hearing);
};

Committee.prototype.scrapeRemote = async function () {
    var comm = this;
    var pages = [];
    try {
        var idx = await comm.getHearingIndex(comm.hearingIndex);
        if (idx) {
            for (var i = 1; i <= idx.lastPage; i++) {
                var page = 'http://www.intelligence.senate.gov/hearings/open?keys=&cnum=All&page=' + i;
                pages.push(page);
                scraper.msg(pages);
            }
        }

        await comm.getPages(pages);
        await comm.fetchAll();
        return Promise.resolve();
    } catch (err) {
        scraper.msg(err);
        process.kill();

        return Promise.reject(err);
    }
};


Committee.prototype.init = async function () {
    var comm = this;
    scraper.committee = this;
    scraper.busy = true;
    /*
      //gets from local file
      (function () {
        return comm.write('test.json');
      }); */
    console.log("here we go...");
    try {
        await comm.validateLocal();
        await scraper.checkBlock();
        await comm.scrapeRemote(); // or comm.readLocal().
        await comm.write();
        await comm.queuePdfs();
        await comm.validateLocal();
        await comm.textifyPdfs();
        await comm.write();
        await comm.getVideos();
        await comm.getVidMeta();
        await comm.write();
        await comm.transcodeVideos();
        scraper.busy = false;

    } catch (err) {
        scraper.msg("something terrible happened");
        scraper.msg(err);

    }
};


Committee.prototype.transcodeVideos = async function () {
    scraper.msg("//////////////////////transcooooode");
    var comm = this;

    for (var hear of this.hearings) {
        var vid = hear.video;
        if (!vid.type) {
            await vid.getMeta();
        }
        scraper.msg("Calling meta func for" + vid.localPath);
        await hear.video.transcodeToMP4().
        scraper.msg("transcoding finished");
        await hear.video.transcodeToOgg();
        await hear.video.transcodeToWebm();
    }



    scraper.msg("Done with transcode!");
    return Promise.resolve();
};


Committee.prototype.getVidMeta = async function () {
    scraper.msg("##META META META##");
    var comm = this;
    for (var hear of this.hearings) {
        var vid = hear.video;
        await vid.getMeta();
    }
    return Promise.resolve();
};


Video.transcode = function () {
    var vid = this;
    return new Promise(function (fulfill) {
        if (fs.existsSync(this.mp4) && fs.existsSync(this.ogg) && fs.existsSync(this.webm)) {
            scraper.msg("All transcoded video files exist");
            fulfill();
        } else {
            if (!fs.existsSync(vid.mp4)) {
                vid.transcodeToMP4.then(function () {
                    return vid.transcode();
                });
            } else if (!fs.existsSync(vid.ogg)) {
                vid.transcodeToOgg().then(function () {
                    return vid.transcode();
                });
            } else if (!fs.existsSync(vid.webm)) {
                vid.transcodeToWebm().then(function () {
                    return vid.transcode();
                });
            }
        }
    });
};

Committee.prototype.getVideos = async function () {
    scraper.msg("SCRAPING VIDEOS");

    for (var hear of this.hearings) {
        var vid = hear.video;
        scraper.msg("Fetching videos for " + hear.shortdate);
        scraper.msg(vid.localPath);
        scraper.msg("Is prototype? " + hear.video.isPrototypeOf(Video));
        try {
            var result = await hear.video.getManifest();
            scraper.msg("MANIFEST LOCATED");
            if (result) {
                return hear.video.fetch(result);
            }
        } catch (err) {
            scraper.msg(err);
            return Promise.reject(err);


        }
    }
    return Promise.resolve();
};


Committee.prototype.readLocal = function () {
    var comm = this;
    return new Promise(function (fulfill, reject) {

        var json = scraper.dataDir + "data.json";
        pfs.readFile(json, 'utf-8').then(function (data) {
            data = JSON.parse(data);
            for (var hear of data.hearings) {
                var theHearing = new Hearing(hear);
                theHearing.witnesses = [];
                if (hear.video) {
                    theHearing.addVideo(JSON.parse(JSON.stringify(hear.video)));
                }
                for (var wit of hear.witnesses) {
                    var theWit = new Witness(JSON.parse(JSON.stringify(wit)));
                    theWit.pdfs = [];
                    scraper.msg("adding PDFS");

                    for (var pdf of wit.pdfs) {
                        scraper.msg(wit.pdfs.length);
                        theWit.readPdf(pdf);
                    }
                    theHearing.addWitness(theWit);

                }
                comm.addHearing(theHearing);

            }
            return fulfill();
        }).catch(function (err) {
            scraper.msg(err);
            return reject(err);
        });
    });
};


Committee.prototype.write = async function (filename) {
    if (!filename) {
        filename = "data.json";
    }
    var comm = this;
    var json = JSON.stringify(comm, undefined, 2);
    var resp = await pfs.writeFile((scraper.dataDir + filename), json);
    return resp;
};


var Witness = function (options) {
    this.pdfs = [];
    for (var fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }
};



Committee.prototype.textifyPdfs = async function () {
    var comm = this,
        pdf;

    for (var hear of comm.hearings) {
        for (var wit of hear.witnesses) {
            for (pdf of wit.pdfs) {
                scraper.msg(JSON.stringify(pdf));
                await pdf.getMeta();
            }

        }
    }
    return Promise.resolve();

};

Committee.prototype.validateLocal = function () {
    scraper.msg("#VALIDATION#");
    var dirs = [scraper.mediaDir, scraper.tempDir, scraper.dataDir, scraper.incomingDir, scraper.metaDir, scraper.videoDir, scraper.textDir, scraper.transcodedDir, scraper.webshotDir];
    dirs.map(function (dir) {

        try {
            fs.mkdirSync(dir);
        } catch (e) {
            scraper.msg("dir exists");
            if (e.code !== 'EEXIST') throw e;
        }

    });
    for (var hear of this.hearings) {
        var flvpath = scraper.videoDir + hear.shortdate + '.flv';
        var mp4path = scraper.videoDir + hear.shortdate + '.mp4';
        if (fs.existsSync(flvpath)) {
            hear.video.localPath = flvpath;
        } else if (fs.existsSync(mp4path)) {
            hear.video.localPath = mp4path;
        }
    }

    return Promise.resolve();

};

Hearing.prototype.addVideo = function (video) {
    video.basename = this.shortdate;
    this.video = new Video(JSON.parse(JSON.stringify(video)));
};

var Pdf = function (options) {
    if (options.url && options.hear) {
        var url = options.url;
        this.remoteUrl = url;
        this.remotefileName = decodeURIComponent(scraper.textDir + path.basename(Url.parse(url).pathname)).split('/').pop();
        this.localName = (options.hear + "_" + this.remotefileName).replace(" ", "");
    } else {
        for (var fld in options) {
            if (options[fld]) {
                this[fld] = options[fld];
            }
        }
    }
};


scraper.getFile = function (url, dest) {
    var digits;
    const lib = url.startsWith('https') ? require('https') : require('http');
    return new Promise(function (fulfill, reject) {
        if (fs.existsSync(dest)) {
            //file exists
            var size = fs.statSync(dest).size;
            scraper.msg(dest + " exists (" + size + ")");
            if (size) {
                scraper.msg("file's okay");
                return fulfill();
            }
            //validate media here?
            scraper.msg('exists but zero bytes, refetching');
            fs.unlinkSync(dest);
            scraper.getFile(url, dest);



            //file does not exist
        } else {
            if (dest.includes('pdf')) {
                digits = 0;
            } else {
                digits = 2;
            }
            scraper.msg("file " + dest + " doesn't exist yet...");
            var file = fs.createWriteStream(dest);
            lib.get(url, function (response) {
                var cur = 0;
                var pct = 0;
                var len = parseInt(response.headers['content-length'], 10);
                var total = len / 1048576; //1048576 - bytes in  1Megabyte
                var lpct;
                scraper.msg("fetching " + url);
                response.pipe(file);
                response.on("data", function (chunk) {
                    cur += chunk.length;
                    var newPct = (100.0 * cur / len).toFixed(digits);
                    if (pct !== newPct) {
                        pct = newPct;
                        scraper.msg("Downloading " + (100.0 * cur / len).toFixed(digits) + "% " + (cur / 1048576).toFixed(2) + " mb " + " Total size: " + total.toFixed(2) + " mb");
                    }
                });
                file.on('data', function (progress) {
                    var mf = Math.floor(progress.percent);

                    if (mf > lpct) {
                        scraper.msg('Processing: ' + mf + '% done');
                        lpct = mf;

                    }
                });
                file.on('error', function (err) {
                    reject(err);
                });
                file.on('finish', function () {
                    file.close();
                    scraper.msg("done writing " + fs.statSync(dest).size + " bytes");
                    return fulfill();
                });
            });
        }
    });

};


Pdf.prototype.getMeta = async function () {
    var pdf = this;
    var input = this.localPath;
    var jsonpath = scraper.metaDir + pdf.localName + ".json";
    scraper.msg(">>>>>>>>>>>>>>" + input + " " + jsonpath);
    if (fs.existsSync(jsonpath)) {
        var msize = fs.statSync(jsonpath).size;
        scraper.msg(jsonpath + " exists! (" + msize + ")");
        if (msize) {
            scraper.msg("meta's already here, moving on");
            return Promise.resolve();
        } else {

        }

    } else {
        scraper.msg("creating metadata...");
        var resp = await exif.metadata(input, async function (err, metadata) {
            if (err) {
                return Promise.reject("exiftool error: " + err);
            } else {
                var json = JSON.stringify(metadata, undefined, 2);
                scraper.msg(json, 'detail');
                await pfs.writeFile(jsonpath, json);
                await pdf.textify();
                return Promise.resolve();

            }
        }); //end metadata
        return resp;
    }
};

Video.prototype.getMeta = async function () {
    var vid = this;
    var input = this.localPath;
    //var mipath = scraper.metaDir + vid.basename + ".mediainfo.json";
    var etpath = scraper.metaDir + vid.basename + ".json";
    var resp = await exif.metadata(input, async function (err, metadata) {
        scraper.msg("metadata for: ", vid);
        var vcode;
        if (err) {
            return Promise.reject(err);
        }
        if (metadata.videoEncoding) {
            vcode = metadata.videoEncoding;
            if (vcode === "On2 VP6") {
                vid.type = "flv";
            } else if (metadata.fileType === "FLV" && vcode === "H.264") {
                vid.type = "hds";
            } else if (metadata.fileType === "MP4" && vcode === "H.264") {
                vid.type = "h264";
            }
        } else if (metadata.fileType === "MP4" && !vcode) {
            vid.type = "mp4";
        } else {
            scraper.msg(JSON.stringify(metadata), 'detail');
        }
        scraper.msg(vid.type);
        if (fs.existsSync(etpath)) {
            vid.metapath = etpath;
            scraper.msg(JSON.stringify(metadata), 'detail');
            scraper.msg('skipping meta');
            return Promise.resolve();
        }
        scraper.msg(JSON.stringify(metadata));
        await pfs.writeFile(etpath, JSON.stringify(metadata));
        vid.metapath = etpath;
        scraper.msg('metadata written');
        return Promise.resolve();
    });
    return resp;
};

Pdf.prototype.imagify = async function () {
    var basename = this.localName.replace(".pdf", "");
    var imgdir = scraper.textDir + basename;
    try {
        fs.mkdirSync(imgdir);
    } catch (e) {
        scraper.msg("dir exists");
    }
    this.imgdir = imgdir;
    var cmd = "convert - density 300 input.pdf - quality 100 " + imgdir + "/basename.png";
    var nc = await cpp.exec(cmd);
    return Promise.resolve();
};

Pdf.prototype.textify = async function () {
    var pdf = this;
    var dest = this.localPath;
    var txtpath = scraper.textDir + this.localName + ".txt";
    this.txtpath = txtpath;
    scraper.msg("working on " + this.txtpath);


    if (fs.existsSync(txtpath)) {
        var msize = fs.statSync(txtpath).size;
        scraper.msg(txtpath + " exists! (" + msize + ")");
        scraper.msg("txt's already here, moving on");
        return Promise.resolve();

    }
    scraper.msg("Attempting to create text: " + txtpath);
    var pdftxt = new pdftotext(dest);
    try {
        var resp = await pdftxt.getText(async function (err, data, cmd) {
            scraper.msg("Extracting text: " + dest);
            if (err) {
                scraper.msg("txt extraction error " + err + " " + cmd);
                reject("txt extraction error " + err + " " + cmd);
            }
            if (!data) {
                scraper.msg("NO ERROR");
                console.error("NO DATA");
                pdf.needsScan = true;
                await pdf.imagify();
                return Promise.resolve();
            }
            scraper.msg("DATA");
            if (data.length > 100) {
                scraper.msg(data.substring(0, 2000) + "...", "txt");
            }
            var fz = await pfs.writeFile((txtpath), data, function (err) {
                scraper.msg('writing file (' + data.length + ')');
                if (err) {
                    scraper.msg("ERROR WRITING TXT" + err);
                    reject(err);
                }
                scraper.msg('text extraction complete');
                pdf.txtpath = txtpath;
            });
            return Promise.resolve();

        });
        console.log(resp);
        return resp;
    } catch (err) {
        throw (err);
    }
};

Committee.prototype.queuePdfs = async function () {
    var pdfs = [];
    for (var hear of this.hearings) {
        scraper.msg(hear.title + ": ");

        for (var wit of hear.witnesses) {
            for (var pdf of wit.pdfs) {
                scraper.msg(" " + pdf.remotefileName);
                await pdf.fetch();
                await pdf.getMeta();

            }
        }
    }
    return Promise.resolve();
};



Pdf.prototype.fetch = async function () {
    scraper.msg("getting " + this.localName);
    var pdf = this;
    var incoming = scraper.incomingDir + pdf.localName;
    var dest = scraper.textDir + pdf.localName;

    if (fs.existsSync(dest)) {
        pdf.localPath = dest;
        return Promise.resolve();
    }
    scraper.msg(incoming + " " + dest);
    await scraper.getFile(pdf.remoteUrl, incoming)
    fs.renameSync(incoming, dest);
    pdf.localPath = dest;
    return Promise.resolve();

};


Hearing.prototype.addWitness = function (witness) {
    scraper.msg("adding " + witness.lastName);
    if (!witness.isPrototypeOf(Witness)) {
        var wit = new Witness(witness);
        this.witnesses.push(wit);
        return wit;
    } else {

        this.witnesses.push(witness);
        return witness;
    }

};


//from scrape
Witness.prototype.addPdf = function (hear, url) {
    for (var pdf of this.pdfs) {
        if (url === pdf.remoteUrl) {
            scraper.msg('blocking duplicate');
            return false;
        }
    }
    var thepdf = new Pdf({
        "hear": hear.shortdate,
        "url": url
    });
    this.pdfs.push(thepdf);


};

//from file
Witness.prototype.readPdf = function (options) {
    var pdf = new Pdf(options);
    this.pdfs.push(pdf);
    return pdf;
};



Committee.prototype.getPages = function (pages) {
    var comm = this;
    return Promise.all(pages.map(function (a) {
        return comm.getHearingIndex(a);
    }));
};

Committee.prototype.fetchAll = async function () {
    for (var hear of this.hearings) {
        await hear.fetch();
    }
    return Promise.resolve();
};

Committee.prototype.getHearingIndex = function (url) {
    var comm = this;
    var lastPage;
    return new Promise(async function (fulfill, reject) {

        var options = {
            url: url,
            agentClass: Agent,
            agentOptions: {
                socksPort: 9050
            },
            headers: {
                'User-Agent': scraper.userAgents[Math.floor(Math.random() * scraper.userAgents.length)]
            }
        };
        scraper.msg("trying " + JSON.stringify(options));
        var imgname = "hearpage" + moment().format("YYYYMMDD");
        await scraper.screenshot(url, imgname);
        scraper.url({
            'url': imgname
        });
        try {
            await request(options, function (error, response, html) {
                if (error) {
                    scraper.msg("error " + error);
                    reject(error);
                }

                if (!error && response.statusCode === 200) {
                    var $ = cheerio.load(html);
                    var pagerLast = $('.pager-last a').attr('href');
                    if (pagerLast) {
                        lastPage = Url.parse(pagerLast, true);
                    }
                    //scraper.msg(lastPage.query.page);
                    $('.views-row').each(function (i, elem) {
                        var hearing = {};
                        hearing.dcDate = $(elem).find('.date-display-single').attr('content');
                        hearing.hearingPage = "" + $(elem).find('.views-field-field-hearing-video').find('a').attr('href');
                        hearing.hearingPage = Url.resolve("http://www.intelligence.senate.gov/", hearing.hearingPage);
                        hearing.title = $(elem).find('.views-field-title').text().trim();
                        var datesplit = $(elem).find('.views-field-field-hearing-date').text().trim().split(' - ');
                        hearing.date = datesplit[0];
                        hearing.time = datesplit[1];

                        if (!hearing.title.includes('Postponed') && !hearing.hearingPage.includes('undefined')) {
                            comm.hearings.push(new Hearing(hearing));
                            scraper.msg(JSON.stringify(comm.hearings), 'detail');

                        }
                    });
                    if (lastPage) {
                        return fulfill({
                            "lastPage": lastPage.query.page
                        });
                    } else {
                        fulfill();
                    }
                } else {
                    scraper.msg("BAD PAGE REQUEST: " + url + " " + response.statusCode);
                    return fulfill('fail');
                }
            }); // end request
        } catch (err) {
            return reject(err);
        }
    }); // end promise

};

Committee.prototype.testNode = function () {
    var comm = this;
    return new Promise(function (fulfill, reject) {
        var options = {
            url: comm.hearingIndex,
            agentClass: Agent,
            agentOptions: {
                socksPort: 9050
            },
            headers: {
                'User-Agent': scraper.userAgents[Math.floor(Math.random() * scraper.userAgents.length)]
            }
        };
        request(options, function (error, response, html) {
            if (error) {
                scraper.msg("CheckBlock is throwing an error: " + error);
                return reject(error);
            }
            if (!response) {
                console.log("dead socket");
                return reject("dead socket");
            }
            if (response.statusCode === 403) {
                scraper.blocked = true;
                scraper.msg(html, "detail");
                scraper.msg("Access denied, Tor exit node has been blocked.");
                fulfill("blocked");
            } else if (response.statusCode === 200) {
                scraper.blocked = false;
                scraper.msg("Tor exit node is not blacklisted by Senate CDN.");
                fulfill("allowed");
            } else if (response.statusCode === 503) {
                scraper.blocked = true;
                scraper.msg("503 - Service Unavailable");
                console.log(html);
                setTimeout(function () {
                    fulfill("blocked")
                }, 5000);
            } else {

                scraper.blocked = true;
                console.log(html);
                reject(response.statusCode);
            }
        });
    });
};

scraper.checkBlock = async function () {
    var scrape = this;
    scraper.msg("Testing for CDN block");
    try {
        var resp = await scrape.committee.testNode();
        if (resp === "allowed") {
            scraper.msg("No block detected.");
            return Promise.resolve();
        } else {
            scraper.msg("Attempting new identity...");
            await scraper.getNewID();
            return Promise.resolve();
        }
    } catch (err) {
        scraper.msg(err);
    };
};

scraper.getNewID = async function () {
    var cmd = '(echo AUTHENTICATE \\"' + scraper.torPass.replace(/\n/g, "") + '\\"; echo SIGNAL NEWNYM; echo quit) | nc localhost ' + scraper.torPort;
    console.log(cmd);
    try {
        var result = await cpp.exec(cmd);

        scraper.msg("SIGNAL NEWNYM");
        scraper.msg(result.stdout);
        await scraper.committee.testNode();
        scraper.msg(result);
        if (result === "blocked") {
            await scraper.getNewID();
            Promise.resolve();
        } else {
            Promise.resolve();

        }
    } catch (err) {
        scraper.msg(err);
        return Promise.reject();
    };
};

scraper.screenshot = async function (url, filename) {

    if (filename.includes("undefined")) {
        console.log("UNDEFINED");
        process.exit();
    }

    console.log("looking for " + scraper.webshotDir + filename);
    if (fs.existsSync(scraper.webshotDir + filename + ".png")) {
        console.log("shot already exists");
        return Promise.resolve();
    }

    console.log("capturing " + url + " to " + filename);
    var command = 'xvfb-run -a -e xv.log node_modules/slimerjs/src/slimerjs ' + scraper.slimerFlags + path.join(__dirname, 'screenshot.js') + " '" + url + "' '" + filename + "'" + '| grep -v GraphicsCriticalError';
    // var command = '/home/aphid/bin/slimerjs ' + scraper.slimerFlags + path.join(__dirname, 'screenshot.js') + " '" + url + "' '" + filename + "'";
    console.log(command);
    var result = await cpp.exec(command, {
        maxBuffer: 500 * 1024
    });

    var response = result.stdout.replace("Vector smash protection is enabled.", "");
    console.log(response);
    var data = JSON.parse(response);
    console.log(data);
    if (data.status === 'denied') {
        scraper.url({
            'url': data.filename
        });
        await scraper.checkBlock();
        fulfill(data);
    }

    console.log("STDOUT:", result.stdout);
    scraper.url({
        'url': filename
    });
    return Promise.resolve(data);
};

Hearing.prototype.fetch = function () {
    var hear = this;
    return new Promise(function (fulfill, reject) {
        var panel;
        scraper.msg("getting info for: " + hear.date);
        scraper.msg(hear.hearingPage);
        var options = {
            url: hear.hearingPage,
            agentClass: Agent,
            agentOptions: {
                socksPort: 9050
            },
            headers: {
                'User-Agent': scraper.userAgents[Math.floor(Math.random() * scraper.userAgents.length)]
            }
        };
        scraper.screenshot(hear.hearingPage, hear.shortdate).then(function () {
            return scraper.url({
                'url': hear.shortdate,
                'title': hear.title
            });
        }).then(function () {

            request(options, function (error, response, html) {
                var target;
                if (error || !response.statusCode) {
                    scraper.msg(hear.hearingPage + " is throwing an error: " + error);
                    reject(error);
                }
                if (response.statusCode === 200) {
                    var $ = cheerio.load(html);
                    target = $('.pane-node-field-hearing-video').find('iframe');
                    scraper.msg(target.html() + " " + target.attr('src'), "detail");
                    hear.addVideo({
                        url: decodeURIComponent(target.attr('src'))
                    });
                    var wits = $('.pane-node-field-hearing-witness');
                    if (wits.find('.pane-title').text().trim() === "Witnesses") {
                        scraper.msg(wits.find('.pane-title').html(), "detail");
                        wits.find('.content').each(function (k, v) {
                            if ($(v).find('.field-name-field-witness-panel').length) {
                                panel = $(v).find('.field-name-field-witness-panel').text().trim().replace(':', '');
                            }

                            var witness = {};
                            target = $(v).find('.field-name-field-witness-firstname');
                            scraper.msg(target.html(), "detail");
                            scraper.msg(target.text().trim(), "detail");
                            witness.firstName = target.text().trim();

                            target = $(v).find('.field-name-field-witness-lastname');
                            scraper.msg(target.html(), "detail");
                            scraper.msg(target.text().trim(), "detail");

                            witness.lastName = target.text().trim();

                            target = $(v).find('.field-name-field-witness-job');
                            scraper.msg(target.html(), "detail");
                            scraper.msg(target.text().trim(), "detail");
                            witness.title = target.text().trim();

                            target = $(v).find('.field-name-field-witness-organization');
                            scraper.msg(target.html(), "detail");
                            scraper.msg(target.text().trim(), "detail");
                            witness.org = target.text().trim();
                            witness.group = panel;
                            var wit = new Witness(witness);
                            scraper.msg(JSON.stringify(wit), "detail");
                            if ($(v).find('li').length) {
                                $(v).find('a').each(function (key, val) {
                                    scraper.msg($(val).html(), "detail");
                                    var pdf = {};
                                    pdf.name = $(val).text();
                                    pdf.url = $(val).attr('href');
                                    if (!pdf.url.includes('http://')) {
                                        pdf.url = intel.url + pdf.url;
                                    }
                                    scraper.msg(pdf, "detail");
                                    wit.addPdf(hear, pdf.url);
                                });
                            }
                            if (witness.firstName) {
                                scraper.msg("new witness: ");
                                hear.addWitness(wit);
                            }
                        }); //end each
                    } // end if
                    scraper.msg("done with " + hear.title);

                } else {
                    scraper.msg("bad request on " + hear.hearingPage + " code: " + response.statusCode);
                } // end status
                fulfill();

            }); // end request

        }).catch(function (err) {
            console.log(err);
            throw (err);
        });
    }); //end promise
};



process.on('unhandledRejection', function (reason, p) {
    scraper.msg("Unhandled Rejection at: Promise ", p, " reason: ", reason);
    // application specific logging, throwing an error, or other logic here
});


var intel = new Committee({
    committee: "Intelligence",
    chamber: "senate",
    url: "http://www.intelligence.senate.gov",
    hearingIndex: "http://www.intelligence.senate.gov/hearings/open",
    shortname: "intel"
});


io.on("connect", function (socket) {
    scraper.connections++;
    scraper.started = true;
    console.log('watching the watcher');
    if (scraper.busy) {
        setTimeout(function () {
            socket.emit("message", "PROCESS IN ACTION, MONITORING");
            io.emit("message", scraper.connections + " active connections");
        }, 3000);
        socket.join("oversight");
        socket.join("urls");
    } else {
        scraper.busy = true;
        setTimeout(function () {
            socket.emit("message", "[RE]STARTING PROCESS");
        }, 3000);
        socket.join("oversight");
        setTimeout(function () {
            intel.init();
        }, 8000);
    }
    socket.on("reconnect", function () {
        scraper.connections++;
        scraper.msg(scraper.connections + " active connections");
    });

    socket.on("disconnect", function () {
        scraper.connections--;
        scraper.msg(scraper.connections + " active connections");
        setTimeout(function () {
            if (scraper.connections < 1) {
                scraper.msg("no quorum");
                scraper.shutDown();
            }
        }, 10000);


    });

});

scraper.shutDown = async function () {
    console.log("SHUTTING DOWN");
    await scraper.cleanupTemp();
    await scraper.cleanupFrags();
    return process.exit(1);
};

process.on('SIGINT', function () {
    scraper.msg("CAUGHT INTERRUPT SIGNAL");
    scraper.shutDown();
});

setInterval(function () {
    console.log(scraper.busy + " " + scraper.connections);
    if (!scraper.connections && scraper.started) {
        scraper.msg("no quorum");
        scraper.shutDown();
    }
}, 15000);