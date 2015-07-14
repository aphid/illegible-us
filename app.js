var request = require('request');
var cheerio = require('cheerio');
var moment = require('moment');
var Url = require('url');
var hearings = [];
var queue = [];
var socks = 5;
var baseUrl = 'http://www.intelligence.senate.gov/hearings/open';
var pdfbase = ''
queue.push(baseUrl);

var Hearing = function (options) {
  for (var fld in options) {
    if (options[fld]) {
      this[fld] = options[fld];
    }
  }
  this.witnesses = [];
};

var Witness = function (options) {
  for (var fld in options) {
    if (options[fld]) {
      this[fld] = options[fld];
    }
  }
};

Hearing.prototype.fetch = function () {
  var hear = this;
  var panel;
  return new Promise(function (fulfill, reject) {
    var witnesses = [];
    console.log(hear.hearingPage);
    request(hear.hearingPage, function (error, response, html) {
      if (!error && response.statusCode == 200) {
        var $ = cheerio.load(html);
        var wits = $('.pane-node-field-hearing-witness');
        if (wits.find('.pane-title').text().trim() === "Witnesses") {
          wits.find('.content').each(function (k, v) {
            if ($(v).find('.field-name-field-witness-panel').length) {
              panel = $(v).find('.field-name-field-witness-panel').text().trim().replace(':', '');
            };

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
                witness.pdfs.push(pdf);
              });
            }
            if (witness.firstName) {
              hear.witnesses.push(new Witness(witness));
            }
          });
          //witsfield - name - field - witness - firstname


        }
      } // end status
      fulfill();
      console.log(JSON.stringify(hear, undefined, 2));
    }); // end request

    //witnesses found in pane-node-field-hearing-witness
    //transcript in pane-node-field-hearing-transcript-txt
    //pdf in pane-node-field-content-pdf
    //open closed: pane-node-field-hearing-type
    //Location: pane-custom pane-1 panel-pane
  });
}

var scrape = function () {


  return new Promise(function (fulfill, reject) {

    console.log(queue.length);

    if (queue.length) {

      var url = queue.pop();
      console.log("trying " + url);
      request(url, function (error, response, html) {
        if (!error && response.statusCode == 200) {
          var $ = cheerio.load(html);
          var next = $('.pager-next a');
          $('.views-row').each(function (i, elem) {
            var hearing = {};
            hearing.dcDate = $(elem).find('.date-display-single').attr('content');
            hearing.hearingPage = "" + $(elem).find('.views-field-field-hearing-video').find('a').attr('href');
            hearing.hearingPage = Url.resolve("http://www.intelligence.senate.gov/", hearing.hearingPage);
            hearing.title = $(elem).find('.views-field-title').text().trim();
            var datesplit = $(elem).find('.views-field-field-hearing-date').text().trim().split(' - ');
            hearing.date = datesplit[0];
            hearing.time = datesplit[1];
            hearings.push(new Hearing(hearing));

          });
          if (next.text()) {
            console.log("Opening next page");
            queue.push(Url.resolve(url, next.attr('href')));
          }
          scrape();
        } // end status
      }); // end request

    } else {
      console.log("done!")
      fulfill();

      return Promise.all(hearings.map(function (a) {
        a.fetch();
      }));
    }
  });
};



process.on('unhandledRejection', function (err, p) {
  console.log('------------------------');
  console.error(err.stack)
});
scrape();