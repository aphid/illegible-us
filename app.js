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
var slimerjs = require('slimerjs');
var binPath = slimerjs.path;
var ffmpeg = require('fluent-ffmpeg');
var fileExists = require('file-exists');
var mimovie = require("mimovie");
var glob = require("glob");

//paths should have trailing slash 
var scraper = {
  dataDir: './data/',
  hearingDir: './data/hearings/',
  textDir: './media/text/',
  incomingDir: './media/incoming/',
  metaDir: './media/metadata/',
  videoDir: './media/video/',
  sockets: 5,
  current: 0,
  queue: [],
  busy: false
};


var Video = function (options) {
  this.localPath = "";
  this.mp4 = "";
  this.webm = "";
  for (var fld in options) {
    if (options[fld]) {
      this[fld] = options[fld];
    }
  }

  return this;
};


Video.prototype.getManifest = function () {
  var vid = this;
  if (fileExists(this.localPath)) {
    console.log("nevermind, file exists");
    return Promise.resolve();
  }
  console.log("Getting remote info about " + vid.basename);
  console.log("getting manifest!");
  return new Promise(function (fulfill, reject) {
    var url = "'" + vid.url + "'";
    url = url.replace('false', 'true');

    //INCOMPATIBLE WITH FRESHPLAYER PLUGIN
    var command = 'xvfb-run -e xvfbfail.log slimerjs ' + path.join(__dirname, 'getManifest.js') + " " + url;
    //var command = 'slimerjs ' + path.join(__dirname, 'getManifest.js') + " " + url;

    console.log(">>>> " + command);
    cpp.exec(command).then(function (result) {

        //WHAT THE ACTUAL FUCK
        var response = result.stdout.replace("Vector smash protection is enabled.", "");
        console.log(response);
        response = JSON.parse(response);
        if (response.type) {
          vid.type = response.type;
        }
        fulfill(response);
      })
      .fail(function (err) {
        console.error('ERROR: ', (err.stack || err));
        reject(err);
      })
      .progress(function (childProcess) {
        console.log('[exec] childProcess.pid: ', childProcess.pid);
      });


  });
};

Video.prototype.fetch = function (data) {
  var vid = this,
    output, incoming;


  return new Promise(function (fulfill, reject) {
    if (!data.type) {
      reject("Problem getting filetype");
    }
    if (data.type === 'flv') {
      console.log("ok, it's a flv!");
      incoming = scraper.incomingDir + vid.basename + ".flv";
      output = scraper.videoDir + vid.basename + ".flv";
      if (fileExists(output)) {
        console.log('file already exists');
        vid.getMeta().then(function () {
          fulfill();
        });
      }
      console.log("Will save to " + output);
      scraper.getFile(data.src, incoming).then(function () {
        fs.renameSync(incoming, output);
        vid.localPath = output;
        return vid.getMeta(output);
      }).then(function () {
        fulfill();
      });
    } else if (data.type === 'mp4') {
      console.log("ok, it's a mp4!");
      incoming = scraper.incomingDir + vid.basename + ".mp4";
      output = scraper.videoDir + vid.basename + ".mp4";

      if (fileExists(output)) {
        console.log('file already exists');
        vid.getMeta().then(function () {
          fulfill();
        });
        fulfill();
      }
      console.log("Will save to " + output);
      scraper.getFile(data.src, incoming).then(function () {
        vid.localPath = output;
        fs.renameSync(incoming, ouput);
        return vid.getMeta(output);
      }).then(function () {
        fulfill();
      });

    } else if (data.type === 'hds') {
      incoming = scraper.incomingDir + vid.basename + ".flv";
      output = scraper.videoDir + vid.basename + ".flv";

      if (fileExists(output)) {
        console.log('file already exists');
        vid.getMeta().then(function () {
          fulfill();
        });
        fulfill();
      } else {
        var command = 'php lib/AdobeHDS.php --manifest "' + data.manifest + '" --auth "' + data.auth + '" --outdir ' + scraper.incomingDir + ' --outfile ' + vid.basename;
        console.log('getting HDS!');
        //var childArgs = [path.join(__dirname, 'lib/AdobeHDS.php'), flags];
        console.log(command);
        cpp.exec(command, {
            maxBuffer: 1024 * 750
          }).fail(function (err) {
            console.error('ERROR: ', (err.stack || err));
          })
          .progress(function (childProcess) {
            console.log('[exec] childProcess.pid: ', childProcess.pid);
          }).then(function (result) {
            fs.renameSync(incoming, ouput);
            vid.localPath = output;
            glob("*Frag*", function (er, files) {
              console.log('deleting ' + files.length + 'files');
              for (var file of files) {
                fs.unlinkSync(file);
              }
            });
          }).then(function () {
            vid.getMeta();
          }).then(function () {
            fulfill();
          });
      }
    }
  });
};

Video.prototype.transcodeToMP4 = function () {
  console.log('mp4 time');
  var vid = this,
    input, output, acodec, vcodec;


  return new Promise(function (fulfill, reject) {

    input = vid.localPath;
    output = scraper.videoDir + vid.basename + '.mp4';
    console.log("transcoding " + input + " to " + output);
    if (fileExists(output)) {
      console.log("Video file already exists " + output);
      fulfill();
    }
    console.log(vid.type + " ??? " + input);
    if (vid.type === 'hds') {
      console.log("HDS");
      input = vid.localPath;
      acodec = 'copy';
      vcodec = 'copy';
    } else if (vid.type === 'flv') {
      console.log("Ack, flv!");
      //real transcode, not remux
      acodec = 'libfaac';
      vcodec = 'libx264';
    } else if (vid.type === 'mp4') {
      acodec = 'libfaac';
      vcodec = 'copy'
    }

    console.log(acodec + " / " + vcodec);

    //var command = 'ffmpeg -i ' + vid.flv + ' -acodec copy -vcodec copy ' + vid.flv.replace('flv', 'mp4');
    ffmpeg(input)
      .output(output)
      .audioCodec(acodec)
      .videoCodec(vcodec)
      .on('end', function () {
        console.log('Processing Finished');
        fulfill();
      })
      .on('error', function (err, stdout, stderr) {
        console.log(err);
        console.log(stderr);
        reject(err);

      })
      .run();
  });

};






Video.prototype.transcodeToWebm = function () {
  console.log('webm time');
  var vid = this;
  var lpct = 0;

  return new Promise(function (fulfill, reject) {
    if (vid.type === 'hds' || vid.type === 'flv') {
      var input = vid.localPath;
      var output = scraper.videoDir + vid.basename + "webm";
      if (fileExists(output)) {
        console.log("webm already exists! " + output);

      } else {

        ffmpeg(input)
          .output(output)
          .on('progress', function (progress) {
            var mf = Math.floor(progress.percent);
            interval = progress.percent;

            if (mf > lpct) {
              console.log('Processing: ' + mf + '% done');
              lpct = mf;

            }
          })
          .audioCodec('libvorbis')
          .videoCodec('libvpx')
          .on('end', function () {
            console.log('webm end fired?');
            console.log('Processing Finished');
          })
          .on('error', function (err, stdout, stderr) {
            console.log(err.message);
            console.log(stderr);
            reject(err);
          })
          .run();
        /* cpp.exec(command).then(function (result) {
          console.log(result.stdout);
          fulfill();
        });*/
      }
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
  var hearing = new Hearing(options);
  for (var hear of this.hearings) {
    if (hear.date === options.date) {
      console.log("likely dupe");
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
          console.log(pages);
        }
      }

    }).then(function () {
      return comm.getPages(pages);
    }).then(function () {
      return comm.fetchAll();
    }).then(function () {
      fulfill();
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

  this.scrapeRemote().
    //comm.readLocal().

  then(function () {
      return comm.write();
    }).then(function () {
      console.log("//////////////////////////////////////");
      console.log("PDFS BEGIN");
      return Promise.all(comm.hearings.map(function (a) {
        console.log("queueing pdfs");
        return a.queuePdfs();
      }));
    }).then(function () {
      return Promise.all(comm.hearings.map(function (a) {
        return a.validateLocal();
      }));

    }).then(function () {
      return comm.getVideos(true);
    }).then(function () {
      return comm.write();

    }).then(function () {
      return comm.transcodeVideos(true);
    })
    .catch(function (err) {
      console.log("something terrible happened");
      console.log(err);

    });

};

Committee.prototype.transcodeVideos = function (init) {
  console.log("//////////////////////transcooooode");
  var comm = this;
  if (init) {
    console.log('initializing transcode queue');
    scraper.tQueue = [];
    for (var hear of comm.hearings) {
      if (hear.video) {
        if (!fileExists(hear.video.webm) || !fileExists(hear.video.mp4))
          scraper.tQueue.push(hear);
      }
    }
  }
  return new Promise(function (fulfill, reject) {
    if (!scraper.tQueue.length) {
      console.log("transcode queue empty");
      fulfill();
    } else {
      var hear = scraper.tQueue.pop();
      hear.video.transcodeToMP4().then(function () {
        console.log("transcoding finished");

        return hear.video.transcodeToWebm();
      }).then(function () {
        fulfill();
      });
    }
  });
};


Video.transcode = function () {
  var vid = this;
  return new Promise(function (fulfill) {
    if (fileExists(this.mp4) && fileExists(this.webm)) {
      fulfill();
    } else {
      if (!fileExists(this.mp4)) {
        vid.transcodeToMP4.then(function () {
          vid.transcode();
        });
      } else if (!fileExists(this.webm)) {
        vid.transcodeToWebm().then(function () {
          vid.transcode();
        });
      }
    }
  });
};

Committee.prototype.getVideos = function (init) {
  var comm = this;
  if (init) {
    console.log('initializing queue');
    scraper.hearQueue = [];
    for (var hear of comm.hearings) {

      scraper.hearQueue.push(hear);


    }
  }
  console.log(scraper.hearQueue.length);

  return new Promise(function (fulfill, reject) {
      if (!scraper.hearQueue.length) {
        console.log("QUEUE EMPTY");
        fulfill();
      } else {
        var hear = scraper.hearQueue.pop();
        console.log(hear);
        console.log(">>><><><><> " + " " + hear.video.localPath + " " + fileExists(hear.video.localPath));
        if (fileExists(hear.video.localPath)) {
          hear.video.getMeta().then(function () {
            console.log("getting meta?");
            fulfill();
          });
        }
      }
      hear.video.getManifest().then(function (result) {
        return hear.video.fetch(result);
      }).then(function () {
        return comm.write();
      }).then(function () {
        comm.getVideos();
      }).catch(function (err) {
        console.log(err);
        reject(err);
      });
    }
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
          if (wit.pdfs) {
            console.log("adding PDFS");

            for (var pdf of wit.pdfs) {
              console.log(wit.pdfs.length);
              theWit.readPdf(pdf);
            }
            theHearing.addWitness(theWit);
          }
        }
        comm.addHearing(theHearing);

      }
      fulfill();
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
      if (err) reject(err);
      console.log("><><><><><><><><>The file was saved!");
      fulfill();
    });
  });
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


Hearing.prototype.textifyPdfs = function () {
  var hear = this;
  return new Promise(function (fulfill) {
    if (!hear.pdfs) {
      fulfill();
    }

    return Promise.all(hear.pdfs.map(function (a) {
      return a.textify();
    }));
  });

};

Hearing.prototype.validateLocal = function () {
  var hear = this;
  console.log("VALIDATION TIME");
  var exts = ['.flv', '.mp4'];
  exts.map(function (ext) {
    var path = scraper.videoDir + hear.shortdate + ext;
    if (fileExists(path)) {
      console.log("Found video at " + path);
      hear.video.localPath = path;
    } else {
      console.log("No video at " + path);
    }
  });
  /*
  var jsonPath = scraper.incomingDir + hear.shortdate + ".json";
  if (fileExists(jsonPath)) {
    //hear.video.meta
  }*/

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
    this.localName = options.hear + "_" + this.remotefileName;
  } else {
    for (var fld in options) {
      if (options[fld]) {
        this[fld] = options[fld];
      }
    }
  }
}


scraper.getFile = function (url, dest) {
  return new Promise(function (fulfill, reject) {
    if (fileExists(dest)) {
      //file exists
      var size = fs.statSync(dest).size;
      console.log(dest + " exists (" + size + ")");
      if (size) {
        console.log("file's okay");
        fulfill();
      } else {
        //validate media here?
        console.log('exists but zero bytes, refetching');
        fs.unlinkSync(dest);
        scraper.getFile(url, dest);


      }
      //file does not exist
    } else {
      console.log("file " + dest + " doesn't exist yet...");
      var file = fs.createWriteStream(dest);
      http.get(url, function (response) {
        var cur = 0;
        var pct = 0;
        var len = parseInt(response.headers['content-length'], 10);
        var total = len / 1048576; //1048576 - bytes in  1Megabyte
        console.log("fetching " + url);
        response.pipe(file);
        response.on("data", function (chunk) {
          cur += chunk.length;
          var newPct = (100.0 * cur / len).toFixed(2);
          if (pct !== newPct) {
            pct = newPct;
            console.log("Downloading " + (100.0 * cur / len).toFixed(2) + "% " + (cur / 1048576).toFixed(2) + " mb " + " Total size: " + total.toFixed(2) + " mb");
          }
        });
        file.on('data', function (progress) {
          var mf = Math.floor(progress.percent);
          interval = progress.percent;

          if (mf > lpct) {
            console.log('Processing: ' + mf + '% done');
            lpct = mf;

          }
        });
        file.on('finish', function () {
          file.close();
          console.log("done writing " + fs.statSync(dest).size + "bytes");
          fulfill();
        });
      });
    }
  });

};


Pdf.prototype.getMeta = function () {
  var pdf = this;
  var input = this.localPath;
  var jsonpath = scraper.metaDir + pdf.localName + ".json";
  console.log("JJJJJJJJJJJ" + input + " " + jsonpath);
  return new Promise(function (fulfill, reject) {
    if (fileExists(jsonpath)) {
      var msize = fs.statSync(jsonpath).size;
      console.log(jsonpath + " exists! (" + msize + ")");
      if (msize) {
        console.log("meta's already here, moving on");
        fulfill();
      } else {
        console.log("Deleting zero size item");
        fs.unlinkSync(jsonpath);
        pdf.getMeta();
      }
    } else {
      console.log("creating metadata...");
      exif.metadata(input, function (err, metadata) {
        if (err) {
          reject("exiftool error: " + err);
        } else {
          //var json = JSON.stringify(metadata, undefined, 2);
          pfs.writeFile(jsonpath, JSON.stringify(metadata, undefined, 2)).then(function () {
            fulfill();
          });

        }
      }); //end metadata
    }
  });
};

Video.prototype.getMeta = function () {
  console.log("#####VIDEO METADATA#######");
  var vid = this;
  var input = this.localPath;
  var mipath = scraper.metaDir + vid.localName + ".mediainfo.json";
  var etpath = scraper.metaDir + vid.localName + ".exiftool.json";
  return new Promise(function (fulfill, reject) {
    if (fileExists(etpath)) {
      fulfill();
    }
    /* mimovie(input, function (err, res) {
      if (err) {
        reject(console.log(err));
      }
      pfs.writeFile(jsonpath, JSON.stringify(res, undefined, 2)).then(function () {
        vid.mimeta = mipath;
        fulfill();
      });
    });
      */

  });

  exif.metadata(input, function (err, metadata) {
    if (err)
      throw err;
    else
      pfs.writeFile(etpath, metadata).then(function () {
        vid.etpath = etpath;
        fulfill();
      });
    //console.log(JSON.parse(metadata));
  });
};

Pdf.prototype.textify = function () {
  console.log("working on " + this.txtpath)
  var pdf = this;
  var dest = this.localPath;
  console.log(fileExists(dest));
  var txtpath = this.localPath.replace('pdf', 'txt')

  return new Promise(function (reject, fulfill) {

    if (fileExists(txtpath)) {
      var msize = fs.statSync(txtpath).size;
      console.log(txtpath + " exists! (" + msize + ")");
      if (msize) {
        console.log("txt's already here, moving on");
        fulfill();
      } else {
        console.log("Deleting zero size item");
        fs.unlinkSync(txtpath);
        pdf.textify();
      }
    } else {
      console.log("Attempting to create text: " + txtpath);
      var pdftxt = new pdftotext(dest);
      pdftxt.getText(function (err, data, cmd) {
        console.log("TEXTIFYING: " + dest);
        if (err) {
          reject("textificationErr " + err + " " + cmd);
        }
        if (!data) {
          console.error("NO DATA");
          pdf.needsScan = true;
          fulfill();
        } else {
          console.log("DATA");
          fs.writeFile((txtpath), data, function (err) {
            console.log('writing file');
            if (err) {
              throw err;
            }
            console.log('fulfilling textify');
            pdf.txtpath = txtpath;
            fulfill();
          });
          // additionally you can also access cmd array
          // it contains params which passed to pdftotext ['filename', '-f', '1', '-l', '1', '-']
          //console.log(cmd.join(' '));
        }
      });
    }
  });
};

Hearing.prototype.queuePdfs = function () {
  var hear = this;
  console.log(this.title + ": ");
  var pdfs = [];
  for (var wit of this.witnesses) {
    if (wit.pdfs) {
      for (var pdf of wit.pdfs) {
        console.log(" " + pdf.remotefileName);
        pdfs.push(pdf);
      }
    }
  }
  return new Promise(function (fulfill, reject) {

    Promise.all(pdfs.map(function (a) {
      console.log('getting meta');
      return a.fetch();
    })).then(function () {
      console.log("getting text");
      return hear.textifyPdfs();
    }).then(function () {
      console.log("done with pdfs");
      fulfill();
    }).catch(function (err) {
      console.log("UH OH");
      reject(err);
    });

  });
};

Pdf.prototype.fetch = function () {
  console.log("####PROCESS#####");
  var pdf = this;
  console.log(pdf);
  return new Promise(function (fulfill, reject) {
    var incoming = scraper.incomingDir + pdf.localName;
    var dest = scraper.textDir + pdf.localName;

    if (fileExists(dest)) {
      fulfill();
    } else {
      console.log(incoming + " " + dest);
      scraper.getFile(pdf.remoteUrl, incoming).then(function () {
          fs.renameSync(incoming, dest);
          pdf.localPath = dest;
          return pdf.getMeta();
        }).then(function () {
          fulfill();
        })
        .catch(function (err) {
          console.log("rejecting" + pdf.localName);
          reject(err);
          //scraper.workQueue();
        });
    }
  });

};


Hearing.prototype.addWitness = function (witness) {
  console.log("adding " + witness.lastName);
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
      console.log('blocking duplicate');
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

    console.log("trying " + url);
    request(url, function (error, response, html) {
      if (error) {
        reject(error);
      }

      if (!error && response.statusCode === 200) {
        var $ = cheerio.load(html);
        var pagerLast = $('.pager-last a').attr('href');
        if (pagerLast) {
          lastPage = Url.parse(pagerLast, true);
        }
        //console.log(lastPage.query.page);
        $('.views-row').each(function (i, elem) {
          var hearing = {};
          hearing.dcDate = $(elem).find('.date-display-single').attr('content');
          hearing.hearingPage = "" + $(elem).find('.views-field-field-hearing-video').find('a').attr('href');
          hearing.hearingPage = Url.resolve("http://www.intelligence.senate.gov/", hearing.hearingPage);
          hearing.title = $(elem).find('.views-field-title').text().trim();
          var datesplit = $(elem).find('.views-field-field-hearing-date').text().trim().split(' - ');
          hearing.date = datesplit[0];
          hearing.time = datesplit[1];
          if (!hearing.title.includes('Postponed')) {
            comm.hearings.push(new Hearing(hearing));
          }
        });

        if (lastPage) {

          fulfill({
            "lastPage": lastPage.query.page
          });
        } else {
          fulfill();
        }
      } else {
        console.log("BAD PAGE REQUEST: " + url);
        fulfill();

      }
    }); // end request
  }); // end promise

};



Hearing.prototype.fetch = function () {
  var hear = this;
  return new Promise(function (fulfill, reject) {
    console.log('starting a fetch');
    var panel;
    console.log("getting info for: " + hear.date);
    console.log(hear.hearingPage);
    request(hear.hearingPage, function (error, response, html) {
      if (error) {
        console.log(hear.hearingPage + " is throwing an error: " + error);
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
              console.log("adding witness");
              hear.addWitness(wit);
            }
          }); //end each

        } // end if
        console.log("done with " + hear.title);

      } else {
        console.log("bad request on " + hear.hearingPage);
      } // end status

      fulfill();

    }); // end request

  }); //end promise
};



process.on('unhandledRejection', function (reason, p) {
  console.log("Unhandled Rejection at: Promise ", p, " reason: ", reason);
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