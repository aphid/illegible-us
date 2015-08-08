var url = phantom.args[0];

var HDS = function (url) {
  url = url.replace("'", "");
  var url = url.replace("false", "true");
  return new Promise(function (resolve, reject) {
    var data = {};
    var vid = {};
    var page = require('webpage').create();

    page.open(url, function () { // executed after loading
      //console.log("<<<<<<");
    });
    page.onResourceReceived = function (response) {
      if (response.url.contains('flv')) {
        data.type = "flv";
        data.src = response.url
        page.close();
        resolve(data);
      }
      if (response.status === 200 && (response.url.contains('manifest')) && (!response.url.contains('gif'))) {
        //console.log(">>>>>>>>>>  " + response.status);
        url = response.url;
        //console.log(url);
        data.type = "hds";
        data.manifest = url;
      }
      if (response.status === 200 && response.url.contains('Frag')) {
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