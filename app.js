var request = require('request');
var cheerio = require('cheerio');
//var moment = require('moment');
var Url = require('url');
var fs = require('graceful-fs');
var pfs = require('fs-promise');
var path = require('path');
var exif = require('exiftool');
var pdftotext = require('pdftotextjs')
var http = require('http');

//paths should have trailing slash 
var scraper = {
  dataPath: './data/',
  hearingPath: './data/hearings/',
  pdfPath: './media/text/',
  videoPath: './media/video/',
  sockets: 5,
  current: 0,
  queue: []
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


Committee.prototype.init = function () {
  var comm = this;
  var pages = [];

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
    return comm.write();
  }).then(function () {
    console.log("PDF time");
    return Promise.all(comm.hearings.map(function (a) {
      return a.queuePdfs();
    }));
  }).then(function () {
    console.log("we have all the text... now video!!");
  }).catch(function () {
    console.log("something terrible happened");
  });

};

Committee.prototype.readLocal = function () {


};


Committee.prototype.write = function () {
  var comm = this;
  return new Promise(function (fulfill, reject) {
    var json = JSON.stringify(comm, undefined, 2);
    pfs.writeFile((scraper.dataPath + "data.json"), json).then(function (err) {
      if (err) reject(err);
      console.log("><><><><><><><><>The file was saved!");
      fulfill();
    });
  });
};

var Hearing = function (options) {
  for (var fld in options) {
    if (options[fld]) {
      this[fld] = options[fld];
    }
  }
  this.witnesses = [];
};

scraper.getFile = function (url, dest) {
  return new Promise(function (fulfill, reject) {
    pfs.access(dest).then(function () {
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
        var file = fs.createWriteStream(dest);
        http.get(url, function (response) {
          console.log("fetching " + url);
          response.pipe(file);
          file.on('finish', function () {
            file.close();
            fulfill();
          });
        });


      }
    }).catch(function () {
      console.log("reject - file doesn't exist");
      //file does not exist, well we should parse err but nope
      var file = fs.createWriteStream(dest);
      http.get(url, function (response) {
        console.log("fetching " + url);
        response.pipe(file);
        file.on('finish', function () {
          file.close();
          console.log("done writing " + fs.statSync(dest).size);
          fulfill();
        });
      });

    });

  });
};


scraper.getMeta = function (dest) {
  console.log("Getting meta");
  return new Promise(function (fulfill, reject) {
    var jsonpath = dest + ".json";
    pfs.access(jsonpath).then(function () {
      var msize = fs.statSync(jsonpath).size;
      console.log(jsonpath + " exists! (" + msize + ")");
      if (msize) {
        console.log("meta's already here, moving on");
        fulfill();
      } else {
        console.log("Deleting zero size item");
        fs.unlinkSync(jsonpath);
      }
    }).catch(function () {
      console.log("meta aint there");

      fs.readFile(dest, function (err, data) {
        if (err) {
          console.log("error reading metadata");
          reject(err);
        }
        exif.metadata(data, function (err, metadata) {
          if (err) {
            throw "exiftool error: " + err;
          } else {
            //var json = JSON.stringify(metadata, undefined, 2);
            pfs.writeFile(jsonpath, JSON.stringify(metadata, undefined, 2)).then(function () {
              fulfill();
            });

          }
        }); //end metadata

      }); //end readfile
    });
  }); //end promise

};

scraper.textify = function (dest) {
  return new Promise(function (reject, fulfill) {
    var txtpath = dest + ".txt";

    pfs.access(txtpath).then(function (stuff) {
      var msize = fs.statSync(txtpath).size;
      console.log(txtpath + " exists! (" + msize + ")");
      if (msize) {
        console.log("txt's already here, moving on");
        fulfill();
      } else {
        console.log("Deleting zero size item");
        fs.unlinkSync(txtpath);
      }
    }).catch(function () {
      var pdf = new pdftotext(dest);
      pdf.getText(function (err, data, cmd) {
        console.log("TEXTIFYING: " + dest);
        if (err) throw err;
        if (!data) {
          console.error("NO DATA");
          fulfill();
        } else {
          console.log("DATA");
          fs.writeFile((dest + ".txt"), data, function (err) {
            console.log('writing file');
            if (err) {
              throw err;
            }
            console.log('fulfilling textify');
            fulfill();
          });
          // additionally you can also access cmd array
          // it contains params which passed to pdftotext ['filename', '-f', '1', '-l', '1', '-']
          //console.log(cmd.join(' '));
        }
      });
    });
  });
};

Hearing.prototype.queuePdfs = function () {
  var hear = this;
  console.log(hear.title + " pdffff");
  var pdfs = [];
  for (var wit of hear.witnesses) {
    if (wit.pdfs) {
      for (var pdf of wit.pdfs) {
        pdfs.push(pdf);
      }
    }
  }
  return Promise.all(pdfs.map(function (a) {
    return scraper.processPDF(pdf);
  }));
};

scraper.processPDF = function (pdf) {
  return new Promise(function (fulfill, reject) {
    /*
    if (!scraper.queue.length) {
      console.log("donezor!");
    }
    console.log(">>>>>>>>>>>>>>>>>" + scraper.current + "<<<<<<<<<<<<<<<<<");
    console.log(">>>>>>" + scraper.queue.length + " to go ");

    if (scraper.current >= scraper.sockets) {
      setTimeout(function () {
        scraper.workQueue();
      }, 5000);
    } else {
      scraper.current++;
      var pdf = scraper.queue.pop();
      */
    var dest = decodeURIComponent(scraper.pdfPath + path.basename(Url.parse(pdf.url).pathname));
    console.log(dest);
    scraper.getFile(pdf.url, dest).then(function () {
      return scraper.getMeta(dest);
    }).then(function () {
      console.log("textifying");
      return scraper.textify(dest);
    }).then(function () {
      console.log('done with ' + dest);
      //scraper.workQueue();
      fulfill();

    }).catch(function () {
      console.log("it's okay");
      fulfill();
      //scraper.workQueue();
    });
  });


};


Hearing.prototype.addWitness = function (witness) {
  console.log("adding " + witness.lastName)
  this.witnesses.push(witness);
  console.log(this.witnesses.length);
};

var Witness = function (options) {
  for (var fld in options) {
    if (options[fld]) {
      this[fld] = options[fld];
    }
  }
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
      if (error) throw error;

      if (!error && response.statusCode == 200) {
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
          comm.hearings.push(new Hearing(hearing));

        });

        if (lastPage) {

          fulfill({
            "lastPage": lastPage.query.page
          });
        } else {
          fulfill();
        }
      } else {
        console.log("BAD PAGE REQUEST");
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

            if ($(v).find('li').length) {
              witness.pdfs = [];
              $(v).find('a').each(function (key, val) {
                var pdf = {};
                pdf.name = $(val).text();
                pdf.url = $(val).attr('href');
                if (!pdf.url.includes('http://')) {
                  pdf.url = intel.url + pdf.url;
                }
                witness.pdfs.push(pdf);
              });
            }
            if (witness.firstName) {
              console.log("adding witness");
              hear.addWitness(new Witness(witness));
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