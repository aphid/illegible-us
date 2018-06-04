/*jslint node: true */
/*jshint -W105 */
/*global require, module, Promise */
//TODO = scrape all hearings, show the closed ones.
//when you find a pdf or video, break of and analyze.
//this should pause scrape.

"use strict";

var request = require('request');
var rq = require('request-promise');
var progress = require('request-progress');
var cheerio = require('cheerio');
var moment = require('moment');
var Url = require('url');
var fs = require('graceful-fs');
var pfs = require('mz/fs');
var path = require('path');
var exif = require('exiftool');
var pdftotext = require('pdftotextjs');
var cpp = require('child-process-promise');
var ffmpeg = require('fluent-ffmpeg');
var Agent = require('socks5-http-client/lib/Agent');
var glob = require("glob");
var fse = require("fs-extra");
var settings = pfs.readFileSync(__dirname + "/settings.json").toString();
settings = settings.replace(/\.\//g, __dirname + "\/");
settings = JSON.parse(settings);


var scraper = {
    secure: settings.secure,
    mode: settings.mode,
    useTor: settings.useTor,
    slimerFlags: "",
    minOverseers: 1,
    busy: false,
    connections: 0,
    started: false,
    blocked: false,
    sockets: 5,
    current: 0,
    userAgents: settings.userAgents,
    reqOptions: {}
};

scraper.agent = function () {
    this.reqOptions.headers = {
        'User-Agent': scraper.userAgents[Math.floor(Math.random() * scraper.userAgents.length)]
    };
};
scraper.agent();


scraper.dataDir = settings[settings.mode + "Paths"].dataDir;
scraper.mediaDir = settings[settings.mode + "Paths"].mediaDir;
scraper.hearingDir = settings[settings.mode + "Paths"].mediaDir;
scraper.textDir = settings[settings.mode + "Paths"].textDir;
scraper.incomingDir = settings[settings.mode + "Paths"].incomingDir;
scraper.metaDir = settings[settings.mode + "Paths"].metaDir;
scraper.videoDir = settings[settings.mode + "Paths"].videoDir;
scraper.transcodedDir = settings[settings.mode + "Paths"].transcodedDir;
scraper.webshotDir = settings[settings.mode + "Paths"].webshotDir;
scraper.tempDir = settings[settings.mode + "Paths"].tempDir;
scraper.slimerPath = settings.slimerPath;

if (scraper.useTor === true) {
    scraper.slimerFlags = " --proxy-type=socks5 --proxy=localhost:9050 ";
    scraper.torPass = fs.readFileSync(__dirname + '/torpass.txt', 'utf8');
    scraper.torPort = 9051; //control
    scraper.reqOptions = {
        agentClass: Agent,
        agentOptions: {
            socksPort: 9050
        }
    };

} else {
    scraper.slimerFlags = " ";
}

scraper.slimerFlags += "--headless ";

if (scraper.secure) {
    var app = require('https').createServer({
        key: fs.readFileSync(__dirname + '/privkey.pem'),
        cert: fs.readFileSync(__dirname + '/cert.pem')
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
    this.parseDate = this.date + " " + moment(this.time, ["h:mmA"]).format("HH:mm");
    this.shortdate = moment(new Date(this.parseDate)).format("YYMMDD");
    this.shorttime = moment(new Date(this.parseDate)).format("hhmm");
    this.shortname = this.shortdate + "_" + this.shorttime;
};

var Video = function (options) {
    var fld;
    this.localPath = "";
    this.ogg = "";
    for (fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }

    return this;
};


Video.prototype.getManifest = async function () {
    console.log("..........................................................");
    await scraper.wait(8);
    //scraper.msg("ADOBE HDS STREAM DETECTED");
    var vid = this;
    if (fs.existsSync(this.localPath)) {
        scraper.msg("nevermind, file already exists");
        return Promise.resolve();
    }
    scraper.msg("Getting remote info about " + vid.basename);
    scraper.msg("Checking stream type");
    var url = "'" + vid.url + "'";
    url = url.replace('false', 'true');

    //INCOMPATIBLE WITH FRESHPLAYER PLUGIN
    var command = scraper.slimerPath + " " + scraper.slimerFlags + path.join(__dirname, 'getManifest.js') + " " + url + '| grep -v GraphicsCriticalError';
    console.log(command);
    //var command = 'slimerjs ' + path.join(__dirname, 'getManifest.js') + " " + url;
    scraper.msg(">>>> " + command.replace(__dirname, "."));

    try {

        var result = await cpp.exec(command);
        scraper.msg("Ignoring vector smash detection.");
        //WHAT THE ACTUAL FUCK
        var response = result.stdout.replace("Vector smash protection is enabled.", "");
        if (response.includes("fault")) {
            await scraper.checkBlock();
            return await vid.getManifest();
        }
        scraper.msg(response);
        response = JSON.parse(response.replace("Vector smash protection is enabled.", ""));
        if (response.status === 'denied') {
            await scraper.checkBlock();
            return await vid.getManifest();

        }
        if (response.status === 'fail') {
            console.log('manifest fail');
            vid.broken = true;

        }
        if (response.type) {
            scraper.msg("Video type: " + response.type);
            vid.type = response.type;
            vid.src = response.src;
        }
        scraper.msg("fulfilling manifest");

        return Promise.resolve();

    } catch (err) {
        throw (err);
    }

};


Video.prototype.fetch = async function (manifest) {
    //because we have probs if the spawn gets refused
    await scraper.checkBlock();
    var vid = this,
        output, incoming;
    if (this.fail) {
        return Promise.resolve();
    }
    if (fs.existsSync(scraper.videoDir + vid.basename + ".flv") || fs.existsSync(scraper.videoDir + vid.basename + ".mp4")) {
        this.localPath = scraper.videoDir + vid.basename + ".mp4";
        this.type = "mp4";
        return Promise.resolve();
    }
    await this.getManifest();
    if (!this.type) {
        this.fail = true;
        console.dir(this);
        return Promise.resolve("Problem getting filetype");
    }



    return new Promise(async function (fulfill, reject) {
        {
            scraper.msg("TYPE: " + vid.type);
            if (vid.type === 'flv' || vid.type === 'mp4') {
                incoming = scraper.incomingDir + vid.basename + '.' + vid.type;
                output = scraper.videoDir + vid.basename + '.' + vid.type;

                scraper.msg("Will save to " + output);
                scraper.getFile(manifest.src, incoming).then(function () {
                    fse.moveSync(incoming, output);
                    vid.localPath = output;
                    return fulfill();
                });
            } else if (vid.type === 'm3u') {
                vid.protocol = "m3u8";
                incoming = scraper.incomingDir + vid.basename + '.mp4';
                output = scraper.videoDir + vid.basename + '.mp4';
                /* if (scraper.mode === "dev") {
                    console.log("writing placeholder to " + output);
                    fs.writeFileSync(output, "placeholder");
                    return fulfill();
                }*/
                incoming = scraper.incomingDir + vid.basename + ".mp4";
                output = scraper.videoDir + vid.basename + ".mp4";

                var childargs = ["--hls-prefer-native", "--proxy", "socks5://127.0.0.1:9050", '-o', incoming, vid.src];
                console.log("youtube-dl " + childargs.join(' '));
                scraper.msg("downloading VOD fragments");
                cpp.spawn("youtube-dl", childargs).fail(function (err) {
                        console.error('spawn error: ', err.stack || err);
                        reject(err);

                    })
                    .progress(async function (cP) {
                        scraper.msg('[exec] childProcess.pid' + cP.pid);
                        cP.stdout.on('data', function (data) {
                            if (data.toString().includes('Connection refused')) {
                                console.log("Blocked");
                                //todo: deal with this.
                            }
                            scraper.msg(data.toString().trim(), 'detail');
                        });
                        cP.stderr.on('data', function (data) {
                            scraper.msg('[spawn] stderr: ' + data.toString().trim());
                        });
                    })

                    .then(function () {
                        fse.moveSync(incoming, output);
                        vid.localPath = output;
                        fulfill();
                    })
                    .catch(async function (err) {
                        if (err.includes("urlopen error")) {
                            scraper.msg("video scrape fail, retrying with manifest");
                            await vid.fetch(manifest);
                        } else {
                            scraper.msg("unknown video scrape error");
                            await vid.fetch(manifest);
                        }
                    });


            } else if (vid.type === 'hds') {
                incoming = scraper.incomingDir + vid.basename + ".flv";
                output = scraper.videoDir + vid.basename + ".flv";
                //var command = 'php lib/AdobeHDS.php --manifest "' + data.manifest + '" --auth "' + data.auth + '" --outdir ' + scraper.incomingDir + ' --outfile ' + vid.basename;
                var childArgs = [
  path.join(__dirname, 'lib/AdobeHDS.php'), "--proxy", "socks5://localhost:9050", "--fproxy", "--manifest", manifest.manifest, "--auth", manifest.auth, '--outdir', scraper.incomingDir, '--outfile', vid.basename];
                scraper.msg('Requesting HDS fragments with credentials:');
                scraper.msg(' Authentication key: ' + manifest.auth);
                scraper.msg(' Manifest: ' + manifest.manifest);
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
                        fse.moveSync(incoming, output);
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
            vid.localPath = output;
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
            .on('progress', function (prog) {
                var mf = Math.floor(prog.percent);

                if (mf > lpct) {
                    scraper.msg('Processing: ' + mf + '% done');
                    lpct = mf;

                }
            })
            .on('end', function () {
                //scraper.msg('Processing Finished');
                fse.moveSync(temp, output);
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






Video.prototype.transcodeToOgg = async function () {
    scraper.msg('TRANSCODING TO OGG VORBIS AUDIO');
    var vid = this;
    var lpct = 0;
    var finished = Promise.resolve();
    if (vid.mp4) {
        var input = vid.localPath;
        var temp = scraper.tempDir + vid.basename + ".ogg";
        var output = scraper.transcodedDir + vid.basename + ".ogg";
        if (fs.existsSync(output)) {
            scraper.msg("ogg already exists! " + output);
            return Promise.resolve();
        }
        try {
            var asdf = await ffmpeg(input)
                .output(temp)
                .on('start', function (commandLine) {
                    scraper.msg('Spawned Ffmpeg with command: ' + commandLine);
                })
                .on('progress', function (prog) {
                    var mf = Math.floor(prog.percent);

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
                    fse.moveSync(temp, output);
                    return finished;
                })
                .on('error', function (err, stdout, stderr) {
                    scraper.msg(err.message);
                    scraper.msg(stderr);
                    return Promise.reject(err);
                })
                .run();
            return asdf;
        } catch (err) {
            scraper.msg(err);
            throw (err);
        }

    } else {
        return Promise.reject("no vidtype?");
    }


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
                .on('progress', function (prog) {
                    var mf = Math.floor(prog.percent);

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
                    fse.moveSync(temp, output);
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
    this.processed = "";
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



Committee.prototype.addHearing = async function (options) {
    options.baseUrl = this.url;
    var hearing = new Hearing(options);
    for (var hear of this.hearings) {
        if (hear.date === options.date) {
            scraper.msg("possible dupe");
            //return false; //no because of same day closed/open hearings.
        }
    }
    this.hearings.push(hearing);
    scraper.hearing(hearing);
    await hearing.fetch();

    return Promise.resolve(hearing);
};

scraper.hearing = function (hearing) {
    io.to('oversight').emit('hearing', hearing);
};

scraper.wait = function (sec) {
    return new Promise(function (resolve) {
        setTimeout(function () {
            resolve();
        }, sec * 1000);
    });
};

//this gets all of the pages
Committee.prototype.scrapeRemote = async function (page) {
    var comm = this;
    var curPage = page || 0;
    var finished = false;
    try {
        while (!finished) {
            scraper.msg("Trying index page " + curPage);
            let url = comm.hearingIndex + curPage;
            let res = await comm.getHearingIndex(url, curPage);
            //console.dir(res);

            if (res === "fail") {
                await scraper.checkBlock();
                await comm.getHearingIndex(url, curPage);
            }
            if (res.pageHearings.length) {
                console.log("Page has", res.pageHearings.length, "hearings");
                scraper.msg(comm.hearings.length + " hearings total.");

            } else {
                console.log("no more hearings");
                finished = true;
                /*
                for (let hear of comm.hearings) {
                    if (!hear.closed) {
                        console.log("fetching", hear.title);
                        await scraper.wait(3);
                        let h = await hear.fetch();
                        await comm.write();

                        if (h) {
                            console.log(h);
                        }
                    }

                } */
                console.log("Finished with page", curPage);
                return Promise.resolve();
            }
            curPage++;
        }
    } catch (err) {
        scraper.msg(err);
        process.exit();

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

        await comm.scrapeRemote(); // or comm.readLocal()
        /*
        console.log(comm.curPage, " of ", comm.lastPage)
        while (comm.curPage < comm.lastPage) {
            console.log("again");
            await comm.write();

            var scrape = await comm.scrapeRemote(); // or comm.readLocal().
            if (scrape !== "blocked") {
                comm.curPage++;
            } else {
                await comm.checkBlock();
            }

            console.log("moving to page ", comm.curPage, "of", comm.lastPage);


        }*/
        /*
        await comm.queuePdfs();
        await comm.validateLocal();
        await comm.textifyPdfs();
        await comm.write();
        await comm.getVideos();
        await comm.getVidMeta();
        await comm.write();
        await comm.transcodeVideos();
        */
        scraper.busy = false;

    } catch (err) {
        scraper.msg("something terrible happened");
        scraper.msg(err);

    }
};


Committee.prototype.transcodeVideos = async function () {
    scraper.msg("//////////////////////transcooooode");

    for (var hear of this.hearings) {
        scraper.msg("transcoding " + hear.shortname);
        var vid = hear.video;
        if (!vid.type) {
            await vid.getMeta();
        }
        scraper.msg("Calling meta func for" + vid.localPath);
        await hear.video.transcodeToMP4();
        scraper.msg("transcoding finished");
        await hear.video.transcodeToOgg();
        await hear.video.transcodeToWebm();
    }



    scraper.msg("Done with transcode!");
    return Promise.resolve();
};


Committee.prototype.getVidMeta = async function () {
    scraper.msg("##META META META##");
    for (var hear of this.hearings) {
        var vid = hear.video;
        await vid.getMeta();
    }
    return Promise.resolve();
};


Video.transcode = function () {
    var vid = this;
    return new Promise(function (fulfill) {
        if (fs.existsSync(vid.mp4) && fs.existsSync(vid.ogg) && fs.existsSync(vid.webm)) {
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
        scraper.msg("Fetching videos for " + hear.shortname);
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
    var archive = scraper.dataDir + moment().format("YYMMDD_hh") + ".json";

    var comm = this;
    comm.processed = moment().format();
    var json = JSON.stringify(comm, undefined, 2);
    var resp = await pfs.writeFile((scraper.dataDir + filename), json);
    resp = await pfs.writeFile((archive), json);
    console.log("writing: ", scraper.dataDir + filename);
    await scraper.wait(5);
    return resp;
};


Committee.prototype.textifyPdfs = async function () {

    for (let hear of this.hearings) {
        for (let wit of hear.witnesses) {
            for (let pdf of wit.pdfs) {
                scraper.msg(JSON.stringify(pdf));
                await pdf.getMeta();
                await pdf.textify();
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
            if (e.code !== 'EEXIST') {
                throw e;
            }
        }

    });
    for (var hear of this.hearings) {
        var flvpath = scraper.videoDir + hear.shortname + '.flv';
        var mp4path = scraper.videoDir + hear.shortname + '.mp4';
        if (fs.existsSync(flvpath)) {
            hear.video.localPath = flvpath;
        } else if (fs.existsSync(mp4path)) {
            hear.video.localPath = mp4path;
        } else {
            console.log("NO LOCALPATH FOR ", hear);
        }
    }

    return Promise.resolve();

};

Hearing.prototype.addVideo = async function (video) {
    var hear = this;

    if (!video.url || video.url === 'undefined') {
        this.videos = false;
        return false;
    }
    video.basename = this.shortname;
    this.video = await new Video(JSON.parse(JSON.stringify(video)));
    console.log("processing video");
    await scraper.wait(5);
    scraper.msg(JSON.stringify(this.video), "detail");
    await this.video.fetch();
    if (this.brokenVideo || this.video.fail) {
        this.video = false;
        this.brokenVideo = true;
        return false;
    }
    await this.video.getMeta();
    //await this.video.transcode();
    var flvpath = scraper.videoDir + hear.shortname + '.flv';
    var mp4path = scraper.videoDir + hear.shortname + '.mp4';
    if (fs.existsSync(flvpath)) {
        hear.video.localPath = flvpath;
    } else if (fs.existsSync(mp4path)) {
        hear.video.localPath = mp4path;
    }

};

var Pdf = function (options) {
    if (options.url && options.hear) {
        var url = options.url;
        this.remoteUrl = url;
        this.remotefileName = decodeURIComponent(scraper.textDir + path.basename(Url.parse(url).pathname)).split('/').pop();
        this.localName = (options.hear + "_" + this.remotefileName).replace(" ", "");
        this.title = options.name || options.title;
    } else {
        for (var fld in options) {
            if (options[fld]) {
                this[fld] = options[fld];
            }
        }
    }
};


scraper.getFile = function (url, dest) {
    console.log("Getting", url, "to", dest);
    var pct = 0;
    return new Promise(function (resolve) {
        if (fs.existsSync(dest)) {
            return resolve("file here already");

        }
        var options = scraper.reqOptions;
        options.url = url;
        progress(request(url), options)
            .on('response', function (response) {
                console.log(response.statusCode); // 200
                console.log(response.headers['content-type']); // 'image/png'
            }).on('progress', function (state) {
                if (Math.floor(state.percent > pct)) {
                    scraper.msg(state.percent.toFixed(4) * 100 + "%", state.time.remaining, "detail");
                }
            })
            .pipe(fs.createWriteStream(dest)).on('finish', function () {
                console.log("FILE'S DONE");
                return resolve({
                    status: "success"
                });
            });
    });
};

Pdf.prototype.getMeta = async function () {
    var pdf = this;
    var input = this.localPath;
    var jsonpath = scraper.textDir + pdf.localName + ".json";
    scraper.msg("pdf meta for " + input + " " + jsonpath);
    if (fs.existsSync(jsonpath)) {
        var msize = fs.statSync(jsonpath).size;
        scraper.msg(jsonpath + " exists! (" + msize + ")");
        if (msize) {
            scraper.msg("meta's already here, moving on");
            var meta = fs.readFileSync(jsonpath, "utf8");
            pdf.metadata = JSON.parse(meta);
            return Promise.resolve();
        }
        return Promise.resolve();


    }
    scraper.msg("creating metadata...");
    var resp = await exif.metadata(input, async function (err, metadata) {
        if (err) {
            return Promise.resolve("exiftool error: " + err);
        }
        if (metadata.fileSize === "0 bytes") {
            return Promise.resolve("file error 0 size?" + await pfs.fileSize(input));
            process.exit();
        }
        var json = JSON.stringify(metadata, undefined, 2);
        scraper.msg(json, 'detail');
        await pfs.writeFile(jsonpath, json);
        pdf.metadata = metadata;

        return Promise.resolve();

    }); //end metadata
    return Promise.resolve(resp);

};

Video.prototype.getMeta = async function () {
    await scraper.wait(10);
    var vid = this;
    var input = this.localPath;
    if (!input) {
        console.log(":-/");

    }
    //var mipath = scraper.metaDir + vid.basename + ".mediainfo.json";

    var etpath = scraper.videoDir + vid.basename + ".json";
    console.log(vid);
    console.log("* * * * * * ", input, "* * * * * *");
    console.log("^ ^ ^ ^ ^ ^ ", vid.localPath, "^ ^ ^ ^ ^ ^");
    if (fs.existsSync(etpath)) {
        vid.metapath = etpath;
        scraper.msg("Video metadata exists.");
        return Promise.resolve();
    }
    console.log("trying metadata");
    var metadata = await scraper.metadata(input);
    console.log(metadata, undefined, 2);
    scraper.msg("metadata for: ", vid.localPath);
    if (metadata.videoEncoding) {
        let vcode = metadata.videoEncoding;
        if (vcode === "On2 VP6") {
            vid.type = "flv";
        } else if (metadata.fileType === "FLV" && vcode === "H.264") {
            vid.type = "hds";
        } else if (metadata.fileType === "MP4" && vcode === "H.264") {
            vid.type = "h264";
        }
    } else if (metadata.fileType === "MP4") {
        vid.type = "mp4";
    }
    scraper.msg(JSON.stringify(metadata), 'detail');
    scraper.msg(vid.type);
    await pfs.writeFile(etpath, JSON.stringify(metadata));
    vid.metapath = etpath;
    scraper.msg('metadata written');
    return Promise.resolve();

};


//TODO make promisified metadata function based on input file.
scraper.metadata = function (input) {
    return new Promise(function (resolve, reject) {
        exif.metadata(input, async function (err, metadata) {
            if (err) {
                console.log("exiftool err " + err);
                reject("exiftool err: " + err);
            }
            if (metadata.fileSize === "0 bytes") {
                return Promise.resolve("file error 0 size?" + await pfs.fileSize(input));
            }
            //var json = JSON.stringify(metadata, undefined, 2);
            resolve(metadata);
        }); //end metadata
    });

};

Pdf.prototype.imagify = async function () {
    console.log(this.metadata);
    console.log("#################MAKING IMAGES################");
    await scraper.wait(6);
    console.log(this);
    var basename = this.localName.replace(".pdf", "").replace("PDF", "");
    var imgdir = scraper.textDir + basename;
    try {
        fs.mkdirSync(imgdir);
    } catch (e) {
        scraper.msg("dir exists... hopefully " + e);
    }
    this.imgdir = imgdir;
    var lastImg = imgdir + "/" + basename + "-" + (this.metadata.pageCount - 1) + ".jpg";
    console.log("checking for ", lastImg);
    if (fs.existsSync(lastImg)) {
        console.log("EXISTS");
        return Promise.resolve();
    }
    console.log("does not exist?");

    var cmd = "convert -colorspace sRGB -density 300 '" + scraper.textDir + this.localName + "' -quality 100 '" + imgdir + "/" + basename + ".jpg'";
    console.log(cmd);
    try {
        await cpp.exec(cmd);
        console.log("#################DONE IMAGES################");
        return Promise.resolve();
    } catch (e) {
        console.log(e);
        throw (e);
    }

};

Pdf.prototype.textify = async function () {
    console.log("@@@@@@@@@@textify@@@@@@@@");
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
        scraper.msg("Extracting text: " + dest);
        try {
            var data = pdftxt.getTextSync();
            if (data) {
                console.log("DATA");
                data = data.toString('utf8');
            }
        } catch (err) {
            scraper.msg(err);
        }
        if (!data || data.length < 300) {
            scraper.msg("ILLEGIBLE DOCUMENT");
            console.error("NO DATA");
            pdf.needsScan = true;
            return Promise.resolve();
        }
        scraper.msg("DATA");
        if (data.length > 100) {
            scraper.msg(data.substring(0, 2000) + "...", "txt");
        } else {
            scraper.msg(data, "ILLEGIBLE DOCUMENT");
            pdf.needsScan = true;
            return Promise.resolve();
        }
        fs.writeFileSync((txtpath), data, 'utf8');
        scraper.msg('writing file (' + data.length + ')');
        scraper.msg('text extraction complete');
        pdf.txtpath = txtpath;
        pdf.hasText = true;
        return Promise.resolve();

    } catch (err) {
        throw (err);
    }
};

Committee.prototype.queuePdfs = async function () {
    for (var hear of this.hearings) {
        scraper.msg(hear.title + ": ");

        for (var wit of hear.witnesses) {
            for (var pdf of wit.pdfs) {
                scraper.msg(" " + pdf.remotefileName);
                await scraper.wait(5);
                await pdf.fetch();
                await pdf.getMeta();
                await pdf.textify();
                await this.write();
                console.log("result of scrape");

            }
        }
    }
    return Promise.resolve();
};



Pdf.prototype.fetch = async function () {
    console.log("^^^^^^^^PDFFETCH^^^^^^^^^^");
    scraper.msg("getting " + this.localName);
    var pdf = this;
    var incoming = scraper.incomingDir + pdf.localName;
    var dest = scraper.textDir + pdf.localName;

    if (fs.existsSync(dest)) {
        console.log("file exists");
        pdf.localPath = dest;
        return Promise.resolve();
    }
    scraper.msg(incoming + " " + dest);
    try {
        var resp = await scraper.getFile(pdf.remoteUrl, incoming);
        console.log("RESP ", resp);
        if (resp.location) {
            scraper.msg("Updating location due to REDIRECT");
            await scraper.wait(4);
            pdf.oldUrl = pdf.remoteUrl;
            pdf.remoteUrl = resp.location;
            await pdf.fetch();
        }
    } catch (err) {
        console.log(err);
    }
    fse.moveSync(incoming, dest);
    pdf.localPath = dest;
    return Promise.resolve();

};


Hearing.prototype.addWitness = function (witness) {
    scraper.msg("adding " + witness.lastName);
    if (!witness.isPrototypeOf(Witness)) {
        var wit = new Witness(witness);
        this.witnesses.push(wit);
        return wit;
    }

    this.witnesses.push(witness);
    return witness;


};


//from scrape
Witness.prototype.addPdf = async function (hear, data) {
    for (var pdf of this.pdfs) {
        if (data.url === pdf.remoteUrl) {
            scraper.msg('blocking duplicate');
            return false;
        }
    }
    console.dir(data);
    var thepdf = new Pdf({
        "hear": hear.shortname,
        "url": data.url,
        "title": data.name,
        "needsScan": false
    });

    this.pdfs.push(thepdf);
    console.log("fetching");

    await thepdf.fetch();
    await scraper.wait(5);
    console.log("metaing");
    await thepdf.getMeta();
    await scraper.wait(5);

    console.log("image-ing");
    await thepdf.textify();
    console.log(thepdf.needsScan);

    if (thepdf.needsScan) {
        console.log("needs scan");
        await thepdf.imagify();
    }

    await scraper.wait(5);
    return Promise.resolve();

};

//from file
Witness.prototype.readPdf = function (options) {
    var pdf = new Pdf(options);
    this.pdfs.push(pdf);
    return pdf;
};



Committee.prototype.getPages = async function (pages) {
    var comm = this;
    return Promise.all(pages.map(async function (a) {
        return await comm.getHearingIndex(a);
    }));
};

Committee.prototype.fetchAll = async function () {
    for (var hear of this.hearings) {
        await hear.fetch();
    }
    return Promise.resolve();
};

Committee.prototype.getHearingIndex = async function (url, page) {
    var pageHearings = [];
    var comm = this;
    var closeds = 0,
        opens = 0;
    var options = scraper.reqOptions;
    options.url = url;
    scraper.msg("trying " + JSON.stringify(options));
    let now = moment().format("YYMM");
    var imgname = "hearpage" + page + now;
    console.log("OK WHAT", now);
    var ss = await scraper.screenshot(url, imgname);
    console.log(ss);
    scraper.url({
        'url': imgname
    });
    await scraper.wait(3);
    try {
        var resp = await rq(options);
        var $ = cheerio.load(resp);
        var tempHearings = [];
        $('.views-row').each(async function (i, elem) {
            var hearing = {};
            hearing.dcDate = $(elem).find('.date-display-single').attr('content');
            hearing.hearingPage = "" + $(elem).find('.views-field-title').find('a').attr('href');
            hearing.hearingPage = Url.resolve("http://www.intelligence.senate.gov/", hearing.hearingPage);
            hearing.title = $(elem).find('.views-field-title').text().trim();
            var datefield = $(elem).find('.views-field-field-hearing-date').text().trim();
            var datesplit = datefield.split(' - ');
            hearing.date = datesplit[0];
            hearing.time = datesplit[1];
            if (!hearing.date) {
                var olddate = hearing.title.match(/(?:\()([^\)]*)(?:\))/gm).map(m => m.slice(1, m.length - 1)).pop();
                olddate = olddate.replace("(", "").replace(")", "");
                //multiple dates a la (February 23, April 13 and September 14, 1988)
                if (olddate.includes("and")) {
                    //TODO FINISH LATER
                }
            }
            var nHear;
            if (hearing.title.includes('Postponed')) {
                scraper.msg("HEARING POSTPONED");
            } else if (datefield === "N/A") {
                console.log("date invalid, cannot process (yet)");
            } else if (hearing.title.includes('Closed')) {
                //scraper.msg(hearing.title);
                hearing.closed = true;
                tempHearings.push(hearing)
                //comm.hearings.push(nHear);
                pageHearings.push(hearing);
                closeds++;
            } else if (hearing.hearingPage === 'undefined') {
                console.log("undefined hearingpage");
            } else {
                tempHearings.push(hearing);
                //comm.hearings.push(nHear);
                pageHearings.push(hearing);
                opens++;
                //scraper.msg(JSON.stringify(comm.hearings), 'detail');

            }
        });
        for (let h of tempHearings) {
            await comm.addHearing(h);
        }
        console.log("Open: ", opens, " Closed: ", closeds);
        console.log(pageHearings.length + ">>???>>>");
        return Promise.resolve({
            "pageHearings": pageHearings
        });


    } catch (err) {
        if (err.statusCode === 403) {
            await scraper.checkBlock();
            return await comm.getHearingIndex(url, page);
        }
        scraper.msg("error ");
        throw (err);
    } finally {
        console.log("><><><><><><>");
    }

};

Committee.prototype.testNode = async function () {
    console.log("))))))))))))))testNode");
    var options = scraper.reqOptions;
    options.url = intel.hearingIndex;
    try {
        var resp = await rq(options);
        scraper.blocked = false;
        scraper.msg("Tor exit node is not blacklisted by Senate CDN. //");
        return Promise.resolve("allowed");


    } catch (err) {

        if (err.statusCode === 403) {
            scraper.blocked = true;
            scraper.msg(err.body, "detail");
            scraper.msg("Access denied, Tor exit node has been blocked. //" + err.statusCode);

            return Promise.resolve("blocked");
        } else if (err.statusCode === 503) {
            scraper.blocked = true;
            scraper.msg("503 - Service Unavailable");
            console.log(err.body);
            await scraper.wait(5);
            return Promise.resolve("blocked");

            scraper.msg("CheckBlock is throwing an error: " + err);
            throw (err);
        }
        return resp;
    };
};

scraper.checkBlock = async function () {
    console.log("((((((checkblock");
    var scrape = this;
    scraper.msg("Testing for CDN block");
    try {
        var resp = await scrape.committee.testNode();
        console.log(">>>>", resp, "<<<<<");
        if (resp === "allowed") {
            scraper.msg("No block detected.");
            return Promise.resolve();
        }
        scraper.msg("Attempting new identity...");
        await scraper.getNewID();
        return await scraper.checkBlock();

    } catch (err) {
        scraper.msg(err);
    };
};

scraper.getNewID = async function () {
    console.log("%%%%%%%%%%%%%%getNewID");
    var cmd = '(echo AUTHENTICATE \\"' + scraper.torPass.replace(/\n/g, "") + '\\"; echo SIGNAL NEWNYM; echo quit) | nc localhost ' + scraper.torPort;
    console.log(cmd);
    try {
        var result = await cpp.exec(cmd);

        scraper.msg("SIGNAL NEWNYM");
        //scraper.msg(result.stdout);
        await scraper.committee.testNode();
        //scraper.msg(result);
        if (result === "blocked") {
            await scraper.getNewID();
            Promise.resolve();
        } else {
            scraper.agent();
            Promise.resolve();

        }
    } catch (err) {
        console.log("ERROR IN GETNEWID");
        scraper.msg(err);
        return Promise.reject();
    };
};

scraper.screenshot = async function (url, filename) {
    console.log(filename);
    if (filename.includes("undefined")) {
        console.log("UNDEFINED");
        process.exit();
    }

    console.log("looking for " + scraper.webshotDir + filename);
    if (fs.existsSync(scraper.webshotDir + filename + ".jpg")) {
        console.log("shot already exists");
        scraper.url({
            'url': filename
        });
        await scraper.wait(3);
        return Promise.resolve();
    }

    console.log("capturing " + url + " to " + filename);
    var command = scraper.slimerPath + " " + scraper.slimerFlags + path.join(__dirname, 'screenshot.js') + " '" + url + "' '" + filename + "'" + '| grep -v GraphicsCriticalError';
    // var command = '/home/aphid/bin/slimerjs ' + scraper.slimerFlags + path.join(__dirname, 'screenshot.js') + " '" + url + "' '" + filename + "'";
    console.log(command);
    var result = await cpp.exec(command, {
        maxBuffer: 500 * 1024
    });

    var response = result.stdout.replace("Vector smash protection is enabled.", "");
    console.log(response);
    var data = JSON.parse(response);
    console.log(data);
    console.log("(*(*(*(*(*(*(*(*(*(*()))))))))))");
    if (data.status === 'denied') {
        scraper.url({
            'url': data.filename
        });
        await scraper.checkBlock();
        return Promise.resolve(data);
    }

    console.log("STDOUT:", result.stdout);
    scraper.url({
        'url': filename
    });
    return Promise.resolve(data);
};

Hearing.prototype.fetch = async function () {
    console.log(">>>>>>>>>>>>>fetching hearing" + this.title);
    var hear = this;
    //TODO panel parsing?
    scraper.msg("getting info for: " + hear.date);
    scraper.msg(hear.hearingPage);
    var options = scraper.reqOptions;
    options.url = hear.hearingPage;
    console.log('generating screenshot for hearing fetch');
    await scraper.screenshot(hear.hearingPage, hear.shortname);
    scraper.url({
        'url': hear.shortname,
        'title': hear.title
    });
    if (hear.closed) {
        await scraper.wait(5);
        scraper.msg("CLOSED HEARING");
        return Promise.resolve();
    }
    scraper.msg("OPEN HEARING");
    console.dir(hear);
    console.dir(options);
    try {
        options.url = this.hearingPage;
        console.log("requesting " + options.url);
        var html = await rq(options);
        var data = await scraper.crunchHtml(html);
        if (!data) {
            console.msg("PARSE FAILED");
            console.log(html);
        }
        console.log(data);


        for (let wit of data.witnesses) {
            var pdfs = wit.pdfs;
            delete wit['pdfs'];
            var witness = new Witness(wit);
            for (let pdf of pdfs) {
                console.dir(pdf);
                await witness.addPdf(hear, pdf);
            }
            await hear.addWitness(witness);
        }
        await hear.addVideo({
            url: data.video
        });
        console.log("ok this should resolve");
        scraper.msg("done with " + hear.title);
        return Promise.resolve();

    } catch (err) {
        if (err.statusCode === 403) {
            await scraper.checkBlock();
            return Promise.resolve("blocked");
        }
        throw (err);
        return Promise.reject();

    }

};

scraper.crunchHtml = function (html) {
    scraper.msg("Processing html: " + html.length);
    return new Promise(function (resolve, reject) {
        var result = {};
        var witnesses = [];
        var $ = cheerio.load(html);
        //console.log($.html());
        var target = $('.pane-node-field-hearing-video').find('iframe');
        //console.log(target);
        //scraper.msg(target.html() + " " + target.attr('src'), "detail");
        if (target) {
            result.video = decodeURIComponent(target.attr('src'));
        }
        scraper.msg("Video url found: " + target.attr('src'), 'detail');
        //var wits = $('.pane-node-field-hearing-witness');
        var wits = $('.field-collection-item-field-hearing-witness'); // get ABOUT attr too, it is a witness ID
        if (wits.length) {
            scraper.msg(wits.find('.pane-title').html(), "detail");
            wits.each(async function (k, v) {
                var panel;
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
                witness.id = $(v).attr('about');
                witness.org = target.text().trim();
                if (panel) {
                    witness.group = panel;
                }
                witness.title = $(v).find('.field-name-field-witness-title').text().trim();

                witnesses.push(witness);
                scraper.msg(JSON.stringify(witness), "detail");
                var pdfs = [];
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
                        pdfs.push(pdf);
                    });
                }
                witness.pdfs = pdfs;


            }); //end each
        }
        if (!target) {
            return reject("no video");
        }
        //console.dir(result);
        result.witnesses = witnesses;
        console.log("RESOLVED");
        return resolve(result);
    });
};
/*
process.on('unhandledRejection', function (reason, p) {
    scraper.msg("Unhandled Rejection at: Promise ", p, " reason: ", reason);
    // application specific logging, throwing an error, or other logic here
});
*/

var intel = new Committee({
    committee: "Intelligence",
    chamber: "senate",
    url: "http://www.intelligence.senate.gov",
    hearingIndex: "http://www.intelligence.senate.gov/hearings?keys=&cnum=All&page=",
    shortname: "intel"
});

if (scraper.minOverseers === 0) {
    intel.init();
}


io.on("connect", function (socket) {
    scraper.connections++;
    scraper.started = true;
    console.log('the eyes have it');
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
            if (scraper.connections < scraper.minOverseers) {
                scraper.msg("no quorum");
                if (scraper.minOverseers > 0) {
                    scraper.shutDown();
                }
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
