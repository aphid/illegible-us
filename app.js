/*jslint node: true */
/*global require, module, Promise, __dirname */

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

var glob = require("glob");
var r = require("rethinkdb");
var http = require('http');
var io = require('socket.io')(9080);


//paths should have trailing slash
var scraper = {
  dataDir: './data/',
  hearingDir: './data/hearings/',
  textDir: './media/text/',
  incomingDir: './media/incoming/',
  metaDir: './media/metadata/',
  videoDir: './media/video/',
  transcodedDir: './media/transcoded/',
  tempDir: "./media/temp/",
  sockets: 5,
  current: 0,
  rdbConn: null,
  rDb: {
    host: 'localhost',
    port: 28015,
    db: 'unrInt'
  }
};

io.on("connection", function (socket) {
  console.log('watching the watcher');
});

scraper.message = function (thing) {
  console.log(thing);
  if (typeof thing === "string") {
    io.emit('message', thing);
  } else {
    io.emit('message', JSON.stringify(thing));
  }
};



scraper.cleanupFrags = function () {
  glob("*Frag*", function (er, files) {
    scraper.message('deleting ' + files.length + ' files');
    for (var file of files) {
      fs.unlinkSync(file);
    }
  });
  return Promise.resolve();
};

scraper.cleanupTemp = function () {
  var cwd = process.cwd();
  process.chdir(scraper.tempDir);
  glob("*Frag*", function (er, files) {
    scraper.message('deleting ' + files.length + 'files');
    for (var file of files) {
      if (file.includes('mp4') || file.includes('ogg')) {
        fs.unlinkSync(file);
      }
    }

  });
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

  scraper.message("&&&&&&&&&&&&&&&&&&&&&&&&&&manifest&&&&&&&&&&&&&&&&&&&&&");
  var vid = this;
  if (fileExists(this.localPath)) {
    scraper.message("nevermind, file exists");
    return Promise.resolve();
  } else {
    scraper.message("Getting remote info about " + vid.basename);
    scraper.message("getting manifest!");
    return new Promise(function (fulfill, reject) {
      var url = "'" + vid.url + "'";
      url = url.replace('false', 'true');

      //INCOMPATIBLE WITH FRESHPLAYER PLUGIN
      //var command = 'xvfb-run -e xvfbfail.log slimerjs ' + path.join(__dirname, 'getManifest.js') + " " + url;
      var command = 'slimerjs ' + path.join(__dirname, 'getManifest.js') + " " + url;

      scraper.message(">>>> " + command);

      cpp.exec(command).then(function (result) {

          //WHAT THE ACTUAL FUCK
          var response = result.stdout.replace("Vector smash protection is enabled.", "");
          scraper.message(response);
          response = JSON.parse(response);
          if (response.type) {
            vid.type = response.type;
          }
          scraper.message("fulfilling manifest");

          fulfill(response);
        })
        .fail(function (err) {
          console.error('ERROR: ', (err.stack || err));
          reject(err);
          process.exit();
        })
        .progress(function (childProcess) {
          scraper.message('[exec] childProcess.pid: ', childProcess.pid);
        });

    });

  }


};

Video.prototype.fetch = function (data) {
  var vid = this,
    output, incoming;
  scraper.message(data);
  if (!data.type) {
    return Promise.reject("Problem getting filetype");
  }
  if (fileExists(scraper.videoDir + vid.basename + ".flv") || fileExists(scraper.videoDir + vid.basename + ".mp4")) {
    return Promise.resolve();
  }
  return new Promise(function (fulfill, reject) {
    {
      scraper.message("TYPE: " + data.type);
      if (data.type === 'flv' || data.type === 'mp4') {
        incoming = scraper.incomingDir + vid.basename + '.' + data.type;
        output = scraper.videoDir + vid.basename + '.' + data.type;

        scraper.message("Will save to " + output);
        scraper.getFile(data.src, incoming).then(function () {
          fs.renameSync(incoming, output);
          vid.localPath = output;
          return fulfill();
        });


      } else if (data.type === 'hds') {
        incoming = scraper.incomingDir + vid.basename + ".flv";
        output = scraper.videoDir + vid.basename + ".flv";
        var command = 'php lib/AdobeHDS.php --manifest "' + data.manifest + '" --auth "' + data.auth + '" --outdir ' + scraper.incomingDir + ' --outfile ' + vid.basename;
        scraper.message('getting HDS!');
        //var childArgs = [path.join(__dirname, 'lib/AdobeHDS.php'), flags];
        scraper.message(command);
        cpp.exec(command, {
            maxBuffer: 1024 * 750
          }).fail(function (err) {
            console.error('ERROR: ', (err.stack || err));
            reject(err);
          })
          .progress(function (childProcess) {
            scraper.message('[exec] childProcess.pid: ', childProcess.pid);
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

  scraper.message('mp4 time');
  var vid = this,
    input, temp, output, acodec, vcodec, lpct = 0;


  return new Promise(function (fulfill, reject) {
    scraper.message(vid);
    input = vid.localPath;
    //transcodes to temp dir rather than destination, copies when transcode is complete so we don't end up with phantom half-finshed files.
    temp = scraper.tempDir + vid.basename + '.mp4';
    output = scraper.transcodedDir + vid.basename + '.mp4';
    scraper.message("transcoding " + input + " to " + output);
    if (fileExists(output)) {
      scraper.message("Video file already exists " + output);
      return fulfill();
    }
    scraper.message(vid.type + " --> " + input);
    if (vid.type === 'hds') {
      scraper.message("HDS");
      input = vid.localPath;
      acodec = 'copy';
      vcodec = 'copy';
    } else if (vid.type === 'flv') {
      scraper.message("Ack, flv!");
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
      scraper.message("I have no idea what I'm working with here.");
    }

    scraper.message(acodec + " / " + vcodec);

    //var command = 'ffmpeg -i ' + vid.flv + ' -acodec copy -vcodec copy ' + vid.flv.replace('flv', 'mp4');
    ffmpeg(input)
      .output(temp)
      .audioCodec(acodec)
      .videoCodec(vcodec)
      .audioChannels(2)
      .on('start', function (commandLine) {
        scraper.message('Spawned Ffmpeg with command: ' + commandLine);
      })
      .on('progress', function (progress) {
        var mf = Math.floor(progress.percent);

        if (mf > lpct) {
          scraper.message('Processing: ' + mf + '% done');
          lpct = mf;

        }
      })
      .on('end', function () {
        //scraper.message('Processing Finished');
        fs.renameSync(temp, output);
        return fulfill();
      })
      .on('error', function (err, stdout, stderr) {
        scraper.message(err);
        scraper.message(stderr);
        return reject(err);

      })
      .run();

  });

};






Video.prototype.transcodeToOgg = function () {
  scraper.message('ogg time');
  var vid = this;
  var lpct = 0;

  return new Promise(function (fulfill, reject) {
    if (vid.type) {
      var input = vid.localPath;
      var temp = scraper.tempDir + vid.basename + ".ogg";
      var output = scraper.transcodedDir + vid.basename + ".ogg";
      if (fileExists(output)) {
        scraper.message("ogg already exists! " + output);
        return fulfill();
      }

      ffmpeg(input)
        .output(temp)
        .on('start', function (commandLine) {
          scraper.message('Spawned Ffmpeg with command: ' + commandLine);
        })
        .on('progress', function (progress) {
          var mf = Math.floor(progress.percent);

          if (mf > lpct) {
            scraper.message('Processing: ' + mf + '% done');
            lpct = mf;

          }
        })
        .audioCodec('libvorbis')
        .audioChannels(2)
        .noVideo()
        .on('end', function () {
          scraper.message('ogg end fired?');
          scraper.message('Processing Finished');
          fs.renameSync(temp, output);
          return fulfill();
        })
        .on('error', function (err, stdout, stderr) {
          scraper.message(err.message);
          scraper.message(stderr);
          reject(err);
        })
        .run();

    }


  });
};


Video.prototype.transcodeToWebm = function () {
  scraper.message('webm time');
  var vid = this;
  var lpct = 0;

  return new Promise(function (fulfill, reject) {
    if (vid.type) {
      var input = vid.localPath;
      var temp = scraper.tempDir + vid.basename + ".webm";
      var output = scraper.transcodedDir + vid.basename + ".webm";
      if (fileExists(output)) {
        scraper.message("webm already exists! " + output);
        return fulfill();
      }

      ffmpeg(input)
        .output(temp)
        .on('start', function (commandLine) {
          scraper.message('Spawned Ffmpeg with command: ' + commandLine);
        })
        .on('progress', function (progress) {
          var mf = Math.floor(progress.percent);

          if (mf > lpct) {
            scraper.message('Processing: ' + mf + '% done');
            lpct = mf;

          }
        })
        .audioCodec('libvorbis')
        .audioChannels(2)
        .videoCodec('libvpx')
        .on('end', function () {
          scraper.message('webm end fired?');
          scraper.message('Processing Finished');
          fs.renameSync(temp, output);
          return fulfill();
        })
        .on('error', function (err, stdout, stderr) {
          scraper.message(err.message);
          scraper.message(stderr);
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
      scraper.message("likely dupe");
      return false;
    }
  }
  this.hearings.push(hearing);
  return hearing;
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
          scraper.message(pages);
        }
      }

    }).then(function () {
      return comm.getPages(pages);
    }).then(function () {
      return comm.fetchAll();
    }).then(function () {
      return fulfill();
    }).catch(function (err) {
      scraper.message(err);
      process.kill();

      reject(err);
    });
  });
};

Committee.prototype.init = function () {
  var comm = this;

  /*
    //gets from local file
    (function () {
      return comm.write('test.json');
    }); */
  comm.validateLocal().

  then(function () {
    return comm.scrapeRemote();
    //comm.readLocal().
  }).
  then(function () {
    return comm.write();
  }).
  then(function () {
      scraper.message("//////////////////////////////////////");
      scraper.message("PDFS BEGIN");
      return comm.queuePdfs();

    }).then(function () {
      return comm.validateLocal();
    }).then(function () {
      return comm.getVideos();
    }).then(function () {
      scraper.message("wooo");
      return comm.write();
    }).then(function () {
      return comm.getVidMeta();
    }).then(function () {
      return comm.textifyPdfs();
    }).then(function () {
      return comm.write();
    }).then(function () {
      return comm.transcodeVideos();

    })
    .catch(function (err) {
      scraper.message("something terrible happened");
      scraper.message(err);

    });
};

Committee.prototype.transcodeVideos = function () {
  scraper.message("//////////////////////transcooooode");
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
        scraper.message("Calling meta func for" + vid.localPath);
        return hear.video.transcodeToMP4().then(function () {
          scraper.message("transcoding finished");

          return hear.video.transcodeToOgg();
        }).then(function () {
          return hear.video.transcodeToWebm();
        });
      });
    });

    queue.then(function () {
      scraper.message("Done with transcode!");
      return fulfill();
    });
  });
};


Committee.prototype.getVidMeta = function () {
  scraper.message("##META META META##");
  var comm = this;
  return new Promise(function (fulfill) {
    var queue = Promise.resolve();
    comm.hearings.forEach(function (hear) {
      var vid = hear.video;
      queue = queue.then(function () {
        scraper.message("Calling meta func for" + vid.localPath);
        return vid.getMeta();
      });
    });

    queue.then(function () {
      scraper.message("Done with metadata");
      return fulfill();
    });
  });
};


Video.transcode = function () {
  var vid = this;
  return new Promise(function (fulfill) {
    if (fileExists(this.mp4) && fileExists(this.ogg) && fileExists(this.webm)) {
      scraper.message("All transcoded video files exist");
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
  scraper.message("))))))))))))))))))))getting videos!");
  var comm = this;
  return new Promise(function (fulfill, reject) {

    var queue = Promise.resolve();
    comm.hearings.forEach(function (hear) {
      var vid = hear.video;
      queue = queue.then(function () {
        scraper.message("Fetching videos for " + hear.shortdate);
        scraper.message(vid.localPath);
        scraper.message(hear.video.isPrototypeOf(Video));
        return hear.video.getManifest().then(function (result) {
          scraper.message("we got a manifest? in theory?");

          if (result) {
            return hear.video.fetch(result);
          }

        }).catch(function (err) {
          scraper.message(err);
          reject(err);
        });

      });
    });

    queue.then(function () {
      scraper.message("Done getting videos");
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
          scraper.message("adding PDFS");

          for (var pdf of wit.pdfs) {
            scraper.message(wit.pdfs.length);
            theWit.readPdf(pdf);
          }
          theHearing.addWitness(theWit);

        }
        comm.addHearing(theHearing);

      }
      return fulfill();
    }).catch(function (err) {
      scraper.message(err);
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
      scraper.message("><><><><><><><><>The file was saved!");
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
  var pdfs = [];
  for (var hear of this.hearings) {
    for (var wit of hear.witnesses) {
      for (var pdf of wit.pdfs) {
        if (!fileExists(this.txtpath)) {
          pdfs.push(pdf);
        }
      }
    }
  }
  if (!pdfs.length) {
    return Promise.resolve();
  } else {

    return new Promise(function (fulfill) {

      var queue = Promise.resolve();
      pdfs.forEach(function (pdf) {
        queue = queue.then(function () {
          return pdf.textify();
        });
      });

      queue.then(function () {
        scraper.message("Done textifying!");
        return fulfill();
      }).catch(function (err) {
        scraper.message("pdf err is " + err);
        return fulfill();
      });
    });
  }
};

Committee.prototype.validateLocal = function () {
  scraper.message("#VALIDATION#");
  var dirs = [scraper.tempDir, scraper.dataDir, scraper.incomingDir, scraper.metaDir, scraper.videoDir];
  dirs.map(function (dir) {

    try {
      scraper.message("MAKING DIR");
      fs.mkdirSync(dir);
    } catch (e) {
      scraper.message(e);
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
  return new Promise(function (fulfill, reject) {
    if (fileExists(dest)) {
      //file exists
      var size = fs.statSync(dest).size;
      scraper.message(dest + " exists (" + size + ")");
      if (size) {
        scraper.message("file's okay");
        return fulfill();
      }
      //validate media here?
      scraper.message('exists but zero bytes, refetching');
      fs.unlinkSync(dest);
      scraper.getFile(url, dest);



      //file does not exist
    } else {
      scraper.message("file " + dest + " doesn't exist yet...");
      var file = fs.createWriteStream(dest);
      http.get(url, function (response) {
        var cur = 0;
        var pct = 0;
        var len = parseInt(response.headers['content-length'], 10);
        var total = len / 1048576; //1048576 - bytes in  1Megabyte
        var lpct;
        scraper.message("fetching " + url);
        response.pipe(file);
        response.on("data", function (chunk) {
          cur += chunk.length;
          var newPct = (100.0 * cur / len).toFixed(2);
          if (pct !== newPct) {
            pct = newPct;
            scraper.message("Downloading " + (100.0 * cur / len).toFixed(2) + "% " + (cur / 1048576).toFixed(2) + " mb " + " Total size: " + total.toFixed(2) + " mb");
          }
        });
        file.on('data', function (progress) {
          var mf = Math.floor(progress.percent);

          if (mf > lpct) {
            scraper.message('Processing: ' + mf + '% done');
            lpct = mf;

          }
        });
        file.on('error', function (err) {
          reject(err);
        });
        file.on('finish', function () {
          file.close();
          scraper.message("done writing " + fs.statSync(dest).size + "bytes");
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
  scraper.message(">>>>>>>>>>>>>>" + input + " " + jsonpath);
  return new Promise(function (fulfill, reject) {
    if (fileExists(jsonpath)) {
      var msize = fs.statSync(jsonpath).size;
      scraper.message(jsonpath + " exists! (" + msize + ")");
      if (msize) {
        scraper.message("meta's already here, moving on");
        return fulfill();
      }

    } else {
      scraper.message("creating metadata...");
      exif.metadata(input, function (err, metadata) {
        if (err) {
          reject("exiftool error: " + err);
        } else {
          //var json = JSON.stringify(metadata, undefined, 2);
          pfs.writeFile(jsonpath, JSON.stringify(metadata, undefined, 2)).then(function () {
            return fulfill();
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
        reject(scraper.message(err));
      }
      pfs.writeFile(jsonpath, JSON.stringify(res, undefined, 2)).then(function () {
        vid.mimeta = mipath;
        fulfill();
      });
    });
      */


    exif.metadata(input, function (err, metadata) {
      scraper.message("metadata for: ", vid);
      var vcode;
      if (err) {
        reject(err);
      }
      scraper.message(metadata);
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
        scraper.message(JSON.stringify(metadata));
      }
      scraper.message(vid.type);
      if (fileExists(etpath)) {
        vid.etpath = etpath;
        scraper.message('skipping meta');
        return fulfill();
      }

      pfs.writeFile(etpath, JSON.stringify(metadata)).then(function () {
        vid.etpath = etpath;
        scraper.message('metadata written');
        return fulfill();
      });
      //scraper.message(JSON.parse(metadata));


    });
  });

};

Pdf.prototype.textify = function () {
  var pdf = this;
  var dest = this.localPath;
  var txtpath = scraper.textDir + this.localName + ".txt";
  this.txtpath = txtpath;
  scraper.message("working on " + this.txtpath);

  return new Promise(function (reject, fulfill) {

    if (fileExists(txtpath)) {
      var msize = fs.statSync(txtpath).size;
      scraper.message(txtpath + " exists! (" + msize + ")");
      scraper.message("txt's already here, moving on");
      return fulfill();

    }
    scraper.message("Attempting to create text: " + txtpath);
    var pdftxt = new pdftotext(dest);
    pdftxt.getText(function (err, data, cmd) {
      scraper.message("TEXTIFYING: " + dest);
      if (err) {
        reject("textificationErr " + err + " " + cmd);
      }
      if (!data) {
        console.error("NO DATA");
        pdf.needsScan = true;
        return fulfill();
      }
      scraper.message("DATA");
      fs.writeFile((txtpath), data, function (err) {
        scraper.message('writing file (' + data.length + ')');
        if (err) {
          reject(err);
        }
        scraper.message('fulfilling textify');
        pdf.txtpath = txtpath;
        return fulfill();
      });
      // additionally you can also access cmd array
      // it contains params which passed to pdftotext ['filename', '-f', '1', '-l', '1', '-']
      //scraper.message(cmd.join(' '));

    });

  });
};

Committee.prototype.queuePdfs = function () {
  var pdfs = [];
  for (var hear of this.hearings) {
    scraper.message(hear.title + ": ");

    for (var wit of hear.witnesses) {
      for (var pdf of wit.pdfs) {
        scraper.message(" " + pdf.remotefileName);
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

        });
      });
    });

    queue.then(function () {
      scraper.message("Done with pdf queue!");
      return fulfill();
    }).catch(function (err) {
      scraper.message("pdf err is " + err);
      return fulfill();
    });
  });
};



Pdf.prototype.fetch = function () {
  scraper.message("getting " + this.localName);
  var pdf = this;
  return new Promise(function (fulfill, reject) {
    var incoming = scraper.incomingDir + pdf.localName;
    var dest = scraper.textDir + pdf.localName;

    if (fileExists(dest)) {
      pdf.localPath = dest;
      return fulfill();
    }
    scraper.message(incoming + " " + dest);
    scraper.getFile(pdf.remoteUrl, incoming).then(function () {
        fs.renameSync(incoming, dest);
        pdf.localPath = dest;
      }).then(function () {
        fulfill();
      })
      .catch(function (err) {
        scraper.message("rejecting" + pdf.localName);
        reject(err);
        //scraper.workQueue();
      });

  });

};


Hearing.prototype.addWitness = function (witness) {
  scraper.message("adding " + witness.lastName);
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
      scraper.message('blocking duplicate');
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
  return Promise.all(comm.hearings.map(function (a) {
    return a.fetch();
  }));

};

Committee.prototype.getHearingIndex = function (url) {
  var comm = this;
  var lastPage;
  return new Promise(function (fulfill, reject) {

    scraper.message("trying " + url);
    var options = {
      url: url,
      headers: {
        'User-Agent': 'Mozilla / 5.0(compatible; MSIE 10.0; Windows NT 6.1; Trident / 6.0'
      }
    };
    request(options, function (error, response, html) {
      if (error) {
        reject(error);
      }

      if (!error && response.statusCode === 200) {
        var $ = cheerio.load(html);
        var pagerLast = $('.pager-last a').attr('href');
        if (pagerLast) {
          lastPage = Url.parse(pagerLast, true);
        }
        //scraper.message(lastPage.query.page);
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
          }
        });

        if (lastPage) {

          return fulfill({
            "lastPage": lastPage.query.page
          });
        } else {
          return fulfill();
        }
      } else {
        scraper.message("BAD PAGE REQUEST: " + url);
        return fulfill('fail');

      }
    }); // end request
  }); // end promise

};



Hearing.prototype.fetch = function () {
  var hear = this;
  return new Promise(function (fulfill, reject) {
    var panel;
    scraper.message("getting info for: " + hear.date);
    scraper.message(hear.hearingPage);
    var options = {
      url: hear.hearingPage,
      headers: {
        'User-Agent': 'Mozilla / 5.0(compatible; MSIE 10.0; Windows NT 6.1; Trident / 6.0'
      }
    };
    request(options, function (error, response, html) {
      if (error) {
        scraper.message(hear.hearingPage + " is throwing an error: " + error);
        reject(error);
      }
      if (response.statusCode === 200) {
        var $ = cheerio.load(html);
        hear.addVideo({
          url: decodeURIComponent($('.pane-node-field-hearing-video').find('iframe').attr('src'))
        });
        var wits = $('.pane-node-field-hearing-witness');
        if (wits.find('.pane-title').text().trim() === "Witnesses") {
          wits.find('.content').each(function (k, v) {
            if ($(v).find('.field-name-field-witness-panel').length) {
              panel = $(v).find('.field-name-field-witness-panel').text().trim().replace(':', '');
            }

            var witness = {};
            witness.firstName = $(v).find('.field-name-field-witness-firstname').text().trim();
            witness.lastName = $(v).find('.field-name-field-witness-lastname').text().trim();
            witness.title = $(v).find('.field-name-field-witness-job').text().trim();
            witness.org = $(v).find('.field-name-field-witness-organization').text().trim();
            witness.group = panel;
            var wit = new Witness(witness);
            if ($(v).find('li').length) {
              $(v).find('a').each(function (key, val) {
                var pdf = {};
                pdf.name = $(val).text();
                pdf.url = $(val).attr('href');
                if (!pdf.url.includes('http://')) {
                  pdf.url = intel.url + pdf.url;
                }
                wit.addPdf(hear, pdf.url);
              });
            }
            if (witness.firstName) {
              scraper.message("adding witness");
              hear.addWitness(wit);
            }
          }); //end each

        } // end if
        scraper.message("done with " + hear.title);

      } else {
        scraper.message("bad request on " + hear.hearingPage);
      } // end status

      return fulfill();

    }); // end request

  }); //end promise
};



process.on('unhandledRejection', function (reason, p) {
  scraper.message("Unhandled Rejection at: Promise ", p, " reason: ", reason);
  // application specific logging, throwing an error, or other logic here
});


var intel = new Committee({
  committee: "Intelligence",
  chamber: "senate",
  url: "http://www.intelligence.senate.gov",
  hearingIndex: "http://www.intelligence.senate.gov/hearings/open",
  shortname: "intel"
});

intel.init();