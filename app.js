var request = require('request');
var cheerio = require('cheerio');
//var moment = require('moment');
var Url = require('url');
var fs = require('fs');

var scraper = {
  dataPath: 'data',
  hearingPath: 'data/hearings',
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
  });

};

Committee.prototype.write = function () {
  var comm = this;
  return new Promise(function (fulfill, reject) {
    var json = JSON.stringify(comm, undefined, 2);
    fs.writeFile((scraper.dataPath + "/data.json"), json, function (err) {
      if (err) {
        return console.log(err);
        reject();
      }
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

      if (!error && response.statusCode === 200) {
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
        console.log("BAD STATUS " + hear.hearingPage);
      } // end status

      fulfill();

    }); // end request

  }); //end promise
};



process.on('unhandledRejection', function (err) {
  console.log('------------------------');
  console.error(err.stack);
});



var intel = new Committee({
  committee: "Intelligence",
  chamber: "senate",
  url: "http://www.intelligence.senate.gov",
  hearingIndex: "http://www.intelligence.senate.gov/hearings/open",
  shortname: "intel"
});

intel.init();