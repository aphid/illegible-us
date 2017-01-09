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
var fileExists = require('file-exists');
var mimovie = require("mimovie");
var ffmpeg = require('fluent-ffmpeg');
var Agent = require('socks5-http-client/lib/Agent');
var glob = require("glob");
var r = require("rethinkdb");

var scraper = {
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
    secure: true,
    privkey: fs.readFileSync('./privkey.pem'),
    cert: fs.readFileSync('./cert.pem'),
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

    torPass: fs.readFileSync('torpass.txt', 'utf8'),
    torPort: 9051,
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

r.connect({
    host: scraper.rDb.host,
    port: scraper.rDb.port
}).then(function (conn) {
    scraper.rdbConn = conn;
    return scraper.setupTables();

});

scraper.setupTables = function () {
    return new Promise(function (fulfill, reject) {

        r.db('unrInt').tableCreate('hearings').run(scraper.rdbConn).then(function (result) {
            scraper.msg(result);
            return fulfill();
        }).catch(function (result) {
            if (result.msg.includes('exists')) {
                scraper.msg("rdb table exists");
                return fulfill();
            }
        });
    });

};


/*
r.db(scraper.rDb.db).tableCreate('hearings').run(scraper.rdbConn, function (err, result) {
  if (err) throw err;
  console.log(JSON.stringify(result, null, 2));
}); */


/*
Object.defineProperty(global, '__line', {
  get: function () {
    return _stack[1].getLineNumber();
  }
});

Object.defineProperty(global, '__stack', {
  get: function () {
    var orig = Error.prepareStackTrace;
    Error.prepareStackTrace = function (_, stack) {
      return stack;
    };
    var err = new Error;
    Error.captureStackTrace(err, arguments.callee);
    var stack = err.stack;
    Error.prepareStackTrace = orig;
    return stack;
  }
});
*/
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

scraper.cleanupFrags = function () {
    return new Promise(function (resolve, reject) {
        glob("*Frag*", function (er, files) {
            if (files.length) {
                scraper.msg('deleting ' + files.length + ' temp fragments');
            }
            for (var file of files) {
                fs.unlinkSync(file);
            }
            resolve();
        });
    });
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
    if (fileExists(this.localPath)) {
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
    if (fileExists(scraper.videoDir + vid.basename + ".flv") || fileExists(scraper.videoDir + vid.basename + ".mp4")) {
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
                //scraper.msg(command);
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
        if (fileExists(output)) {
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
            if (fileExists(output)) {
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
            if (fileExists(output)) {
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

Committee.prototype.scrapeRemote = function () {
    var comm = this;
    var pages = [];

    return new Promise(function (fulfill, reject) {
        comm.getHearingIndex(comm.hearingIndex).then(function (resolve) {
            if (resolve) {
                for (var i = 1; i <= resolve.lastPage; i++) {
                    var page = 'http://www.intelligence.senate.gov/hearings/open?keys=&cnum=All&page=' + i;
                    pages.push(page);
                    scraper.msg(pages);
                }
            }

        }).then(function () {
            return comm.getPages(pages);
        }).then(function () {
            return comm.fetchAll();
        }).then(function () {
            return fulfill();
        }).catch(function (err) {
            scraper.msg(err);
            process.kill();

            reject(err);
        });
    });
};

Committee.prototype.init = function () {
    var comm = this;
    scraper.committee = this;
    scraper.busy = true;
    /*
      //gets from local file
      (function () {
        return comm.write('test.json');
      }); */
    console.log("here we go...");
    comm.validateLocal().
    then(function () {
        return scraper.checkBlock();
    }).
    then(function () {
        return comm.scrapeRemote();
        //comm.readLocal().
    }).
    then(function () {
        return comm.write();
    }).
    then(function () {
            scraper.msg("//////////////////////////////////////");
            scraper.msg("PDFS BEGIN");
            return comm.queuePdfs();

        }).then(function () {
            return comm.validateLocal();
        }).then(function () {
            //return comm.textifyPdfs();   
        }).then(function () {
            scraper.msg("wooo");
            return comm.write();
        }).then(function () {
            return comm.getVideos();
        }).then(function () {
            return comm.getVideos();
        }).then(function () {
            return comm.getVidMeta();
        }).then(function () {
            return comm.write();
        }).then(function () {
            return comm.transcodeVideos();
        }).then(function () {
            scraper.busy = false;

        })
        .catch(function (err) {
            scraper.msg("something terrible happened");
            scraper.msg(err);

        });
};


Committee.prototype.transcodeVideos = function () {
    scraper.msg("//////////////////////transcooooode");
    var comm = this;


    return new Promise(function (fulfill) {

        var queue = Promise.resolve();
        comm.hearings.forEach(function (hear) {
            var vid = hear.video;
            if (!vid.type) {
                queue = queue.then(function () {
                    return vid.getMeta();
                });
            }
            queue = queue.then(function () {
                scraper.msg("Calling meta func for" + vid.localPath);
                return hear.video.transcodeToMP4().then(function () {
                    scraper.msg("transcoding finished");

                    return hear.video.transcodeToOgg();
                }).then(function () {
                    return hear.video.transcodeToWebm();
                });
            });
        });

        queue.then(function () {
            scraper.msg("Done with transcode!");
            return fulfill();
        });
    });
};


Committee.prototype.getVidMeta = function () {
    scraper.msg("##META META META##");
    var comm = this;
    return new Promise(function (fulfill) {
        var queue = Promise.resolve();
        comm.hearings.forEach(function (hear) {
            var vid = hear.video;
            queue = queue.then(function () {
                scraper.msg("Calling meta func for" + vid.localPath);
                return vid.getMeta();
            });
        });

        queue.then(function () {
            scraper.msg("Done with metadata");
            return fulfill();
        });
    });
};


Video.transcode = function () {
    var vid = this;
    return new Promise(function (fulfill) {
        if (fileExists(this.mp4) && fileExists(this.ogg) && fileExists(this.webm)) {
            scraper.msg("All transcoded video files exist");
            fulfill();
        } else {
            if (!fileExists(vid.mp4)) {
                vid.transcodeToMP4.then(function () {
                    return vid.transcode();
                });
            } else if (!fileExists(vid.ogg)) {
                vid.transcodeToOgg().then(function () {
                    return vid.transcode();
                });
            } else if (!fileExists(vid.webm)) {
                vid.transcodeToWebm().then(function () {
                    return vid.transcode();
                });
            }
        }
    });
};

Committee.prototype.getVideos = function () {
    scraper.msg("SCRAPING VIDEOS");
    var comm = this;
    return new Promise(function (fulfill, reject) {

        var queue = Promise.resolve();
        comm.hearings.forEach(function (hear) {
            var vid = hear.video;
            queue = queue.then(function () {
                scraper.msg("Fetching videos for " + hear.shortdate);
                scraper.msg(vid.localPath);
                scraper.msg("Is prototype? " + hear.video.isPrototypeOf(Video));
                return hear.video.getManifest().then(function (result) {
                    scraper.msg("MANIFEST LOCATED");
                    if (result) {
                        return hear.video.fetch(result);
                    }

                }).catch(function (err) {
                    scraper.msg(err);
                    reject(err);
                });

            });
        });

        queue.then(function () {
            scraper.msg("Done getting videos");
            return fulfill();
        });

    });
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


Committee.prototype.write = function (filename) {
    if (!filename) {
        filename = "data.json";
    }
    var comm = this;
    return new Promise(function (fulfill, reject) {
        var json = JSON.stringify(comm, undefined, 2);
        pfs.writeFile((scraper.dataDir + filename), json).then(function (err) {
            if (err) {
                reject(err);
            }
            scraper.msg("><><><><><><><><>The file was saved!");
            return fulfill();
        });
    });
};


var Witness = function (options) {
    this.pdfs = [];
    for (var fld in options) {
        if (options[fld]) {
            this[fld] = options[fld];
        }
    }
};



Committee.prototype.textifyPdfs = function () {
    var comm = this,
        pdf;
    return new Promise(function (fulfill, reject) {
        var queue = Promise.resolve();
        var pdfs = [];
        for (var hear of comm.hearings) {
            for (var wit of hear.witnesses) {
                for (pdf of wit.pdfs) {
                    scraper.msg(JSON.stringify(pdf));
                    pdfs.push(pdf);
                }

            }
        }
        for (pdf of pdfs) {
            queue = queue.then(function () {
                pdf.textify();
            });
        }
        queue.then(function () {
            scraper.msg("Done extracting text!");
            return fulfill();
        });
        /*
        .catch(function (err) {
             scraper.msg("pdf err is " + err);
             return reject();    
          });*/
    });
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
        if (fileExists(flvpath)) {
            hear.video.localPath = flvpath;
        } else if (fileExists(mp4path)) {
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
    return new Promise(function (fulfill, reject) {
        if (fileExists(dest)) {
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
            http.get(url, function (response) {
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


Pdf.prototype.getMeta = function () {
    var pdf = this;
    var input = this.localPath;
    var jsonpath = scraper.metaDir + pdf.localName + ".json";
    scraper.msg(">>>>>>>>>>>>>>" + input + " " + jsonpath);
    return new Promise(function (fulfill, reject) {
        if (fileExists(jsonpath)) {
            var msize = fs.statSync(jsonpath).size;
            scraper.msg(jsonpath + " exists! (" + msize + ")");
            if (msize) {
                scraper.msg("meta's already here, moving on");
                return fulfill();
            }

        } else {
            scraper.msg("creating metadata...");
            exif.metadata(input, function (err, metadata) {
                if (err) {
                    reject("exiftool error: " + err);
                } else {
                    var json = JSON.stringify(metadata, undefined, 2);
                    scraper.msg(json, 'detail');
                    pfs.writeFile(jsonpath, json).then(function () {
                        pdf.textify();

                    }).then(function () {
                        setTimeout(function () {
                            return fulfill();
                        }, 4500);
                    });

                }
            }); //end metadata
        }
    });
};

Video.prototype.getMeta = function () {
    var vid = this;
    var input = this.localPath;
    var mipath = scraper.metaDir + vid.basename + ".mediainfo.json";
    var etpath = scraper.metaDir + vid.basename + ".exiftool.json";
    return new Promise(function (fulfill, reject) {
        /* mimovie(input, function (err, res) {
          if (err) {
            reject(scraper.msg(err));
          }
          pfs.writeFile(jsonpath, JSON.stringify(res, undefined, 2)).then(function () {
            vid.mimeta = mipath;
            fulfill();
          });
        });
          */


        exif.metadata(input, function (err, metadata) {
            scraper.msg("metadata for: ", vid);
            var vcode;
            if (err) {
                reject(err);
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
            if (fileExists(etpath)) {
                vid.etpath = etpath;
                scraper.msg(JSON.stringify(metadata), 'detail');
                scraper.msg('skipping meta');
                return fulfill();
            }
            scraper.msg(JSON.stringify(metadata));
            pfs.writeFile(etpath, JSON.stringify(metadata)).then(function () {
                vid.etpath = etpath;
                scraper.msg('metadata written');
                setTimeout(function () {
                    return fulfill();
                }, 4500);
            });


        });
    });

};

Pdf.prototype.imagify = function () {
    //STUB!!! if pdf doesn't have data/text then break into images for OCR.

    var pdf = this;
    var dest = ""; //where do image files go?

    return new Promise(function (fulfill, reject) {
        fulfill();
    });

};

Pdf.prototype.textify = function () {
    var pdf = this;
    var dest = this.localPath;
    var txtpath = scraper.textDir + this.localName + ".txt";
    this.txtpath = txtpath;
    scraper.msg("working on " + this.txtpath);

    return new Promise(function (fulfill, reject) {

        if (fileExists(txtpath)) {
            var msize = fs.statSync(txtpath).size;
            scraper.msg(txtpath + " exists! (" + msize + ")");
            scraper.msg("txt's already here, moving on");
            fulfill();

        }
        scraper.msg("Attempting to create text: " + txtpath);
        var pdftxt = new pdftotext(dest);
        pdftxt.getText(function (err, data, cmd) {
            scraper.msg("Extracting text: " + dest);
            if (err) {
                scraper.msg("txt extraction error " + err + " " + cmd);
                reject("txt extraction error " + err + " " + cmd);
            }
            if (!data) {
                scraper.msg("NO ERROR");
                console.error("NO DATA");
                pdf.needsScan = true;
                fulfill();
            }
            scraper.msg("DATA");
            if (data.length > 100) {
                scraper.msg(data.substring(0, 2000) + "...", "txt");
            }
            fs.writeFile((txtpath), data, function (err) {
                scraper.msg('writing file (' + data.length + ')');
                if (err) {
                    scraper.msg("ERROR WRITING TXT" + err);
                    reject(err);
                }
                scraper.msg('text extraction complete');
                pdf.txtpath = txtpath;
                fulfill();
            });
        });
    });
};

Committee.prototype.queuePdfs = function () {
    var pdfs = [];
    for (var hear of this.hearings) {
        scraper.msg(hear.title + ": ");

        for (var wit of hear.witnesses) {
            for (var pdf of wit.pdfs) {
                scraper.msg(" " + pdf.remotefileName);
                pdfs.push(pdf);
            }
        }
    }
    return new Promise(function (fulfill) {

        var queue = Promise.resolve();
        pdfs.forEach(function (pdf) {
            queue = queue.then(function () {
                return pdf.fetch().then(function () {
                    return pdf.getMeta();

                }).then(function () {
                    return pdf.imagify();
                });
            });
        });

        queue.then(function () {
            scraper.msg("Done with pdf queue!");
            return fulfill();
        }).catch(function (err) {
            scraper.msg("pdf err is " + err);
            return fulfill();
        });
    });
};



Pdf.prototype.fetch = function () {
    scraper.msg("getting " + this.localName);
    var pdf = this;
    return new Promise(function (fulfill, reject) {
        var incoming = scraper.incomingDir + pdf.localName;
        var dest = scraper.textDir + pdf.localName;

        if (fileExists(dest)) {
            pdf.localPath = dest;
            return fulfill();
        }
        scraper.msg(incoming + " " + dest);
        scraper.getFile(pdf.remoteUrl, incoming).then(function () {
                fs.renameSync(incoming, dest);
                pdf.localPath = dest;
            }).then(function () {
                fulfill();
            })
            .catch(function (err) {
                scraper.msg("rejecting" + pdf.localName);
                reject(err);
                //scraper.workQueue();
            });

    });

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

Committee.prototype.fetchAll = function () {
    var comm = this;
    return new Promise(function (fulfill, reject) {

        var queue = Promise.resolve();
        comm.hearings.forEach(function (hear) {
            queue = queue.then(function () {
                return hear.fetch();
            });
        });
        queue.then(function () {
            return fulfill();
        });
    });
};

Committee.prototype.getHearingIndex = function (url) {
    var comm = this;
    var lastPage;
    return new Promise(function (fulfill, reject) {

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
        scraper.screenshot(url, imgname).then(function () {
            return scraper.url({
                'url': imgname
            });
        }).then(function () {
            request(options, function (error, response, html) {
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
                        /* scraper.url({
                          'url': url
                        }); */
                        fulfill();
                    }
                } else {
                    scraper.msg("BAD PAGE REQUEST: " + url + " " + response.statusCode);
                    return fulfill('fail');
                }
            }); // end request
        }); // end then
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
                reject(error);
            }
            if (!response) {
                console.log("dead socket");
                reject("dead socket");
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

scraper.checkBlock = function () {
    var scrape = this;
    scraper.msg("Testing for CDN block");
    return new Promise(function (fulfill, reject) {
        scrape.committee.testNode().then(function (result) {
            if (result === "allowed") {
                //scraper.msg("No block detected.");
                fulfill();
            } else {
                scraper.msg("Attempting new identity...");
                return scraper.getNewID().then(fulfill);
            }
        }).catch(function (err) {
            scraper.msg(err);
        });
    });

};


scraper.getNewID = function () {
    return new Promise(function (fulfill, reject) {
        var cmd = '(echo AUTHENTICATE \\"' + scraper.torPass.replace(/\n/g,"") + '\\"; echo SIGNAL NEWNYM; echo quit) | nc localhost ' + scraper.torPort;
        console.log(cmd);
        var nc = cpp.exec(cmd).then(function (result) {
            scraper.msg("SIGNAL NEWNYM");
            scraper.msg(result.stdout);
            return scraper.committee.testNode();
        }).then(function (result) {
            scraper.msg(result);
            if (result === "blocked") {
                return scraper.getNewID().then(fulfill);
            } else {
                fulfill();
            }
        }).catch(function (err) {
            scraper.msg(err);
            return reject();
        });
    });
};

scraper.screenshot = function (url, filename) {

    if (filename.includes("undefined")) {
        console.log("UNDEFINED");
        process.exit();
    }

    return new Promise(function (fulfill, reject) {

        if (fileExists(scraper.webshotDir + filename)) {
            console.log("shot already exists");
            return fulfill();
        }

        console.log("capturing " + url + " to " + filename);
        var command = 'xvfb-run -a -e xv.log node_modules/slimerjs/src/slimerjs ' + scraper.slimerFlags + path.join(__dirname, 'screenshot.js') + " '" + url + "' '" + filename + "'" + '| grep -v GraphicsCriticalError';
       // var command = '/home/aphid/bin/slimerjs ' + scraper.slimerFlags + path.join(__dirname, 'screenshot.js') + " '" + url + "' '" + filename + "'";
        console.log(command);
        cpp.exec(command, {
                maxBuffer: 500 * 1024
            }).then(function (result) {
                var response = result.stdout.replace("Vector smash protection is enabled.", "");
                console.log(response);
                var data = JSON.parse(response);
                console.log(data);
                if (data.status === 'denied') {
                    scraper.url({
                        'url': data.filename
                    });
                    scraper.checkBlock().then(function () {
                        fulfill();
                    });
                }
                console.log("STDOUT:", result.stdout);
                scraper.url({
                    'url': filename
                });
                return fulfill();
            })
            .fail(function (err) {
                console.error('ERROR: ', (err.stack || err));
                //reject(err);
                console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!shutting down");
                scraper.screenshot(url, filename).then(fulfill);
                //process.exit(1);
            })
            .progress(function (childProcess) {
                scraper.msg('[exec] childProcess.pid: ', childProcess.pid);
            });
    }); //promise
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
                if (error) {
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

scraper.shutDown = function () {
    console.log("SHUTTING DOWN");
    scraper.cleanupTemp().then(function () {
        return scraper.cleanupFrags();
    }).then(function () {
        scraper.msg("EXITING");
        return process.exit(1);
    });

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
