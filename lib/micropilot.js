/*! vim:set ts=2 sw=2 sts=2 expandtab */
/*! This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";


/**
  * Example Usage for module:
  *
  * ```
  * require('micropilot').Micropilot("mystudy").
  *   watch(['topic1','topic2']).run(84600 * 1000).
  *   then(function(mtp){
  *    mtp.upload(url); mtp.stop()
  *   })
  * ```
  *
  * @module main
*/

/*!*/
const { Class } = require('sdk/core/heritage');
const { Collection } = require("collection");
const { defer, promised, resolve } = require('api-utils/promise');
const { indexedDB } = require('./indexed-db'); // until it goes back in sdk
const observer = require("observer-service");
const pb = require("private-browsing");
const myprefs = require("simple-prefs").prefs;
const Request = require("request").Request;
const {storage} = require("simple-storage");
const timers = require("timers");
const uuid = require('sdk/util/uuid').uuid;


/** Random UUID as string, without braces.
 *
 * @return {string} random uuid without braces
 *
 * @memberOf main
 * @name uu
 */
let uu = exports.uu = function(){
        return uuid().number.slice(1,-1)
};

/** Upload url
  *
  * Usage:
  * ```
  *  Micropilot('mystudy').record({'a':1}).then(function(mtp){
  *    mtp.upload(UPLOAD_URL + mtp.studyid);
  *  })
  * ```
  * @memberOf main
  * @name UPLOAD_URL
  */
let UPLOAD_URL = exports.UPLOAD_URL = "https://testpilot.mozillalabs.com/submit/";

// Warning: micropilot steals the simple store 'micropilot' key by name
if (storage.micropilot===undefined) storage.micropilot = {};

/** common generic function to handle request errors
  *
  * Console errors the error code.
  *
  * @memberOf main
  * @name requestError
  */
let requestError = function(evt) console.error(evt.target.errorCode);


/**
  * EventStore Constructor (Heritage)
  * @module EventStore
  */
let EventStore = exports.EventStore = Class({

  /** Create an event store.
    *
    * @param {string} collection used in db and objectStore names.
    * @param {string} key autoincrement key, (default: "eventstoreid")
    *
    * @return EventStore instance
    * @memberOf EventStore
    * @name initialize
    */
  initialize: function(collection,keyname){
    this.collection = collection;
    this.keyname = keyname || "eventstoreid";
  },
  type: "EventStore",
  /** promise a indexedDB connection to `"micropilot-"+this.collection`.
    *
    * If first connection to db, creates object store:
    *
    * `createObjectStore(that.collection,{keyPath: that.keyname, autoIncrement: true }`
    *
    * Resolves on success with (`request.result`)
    *
    * @memberOf EventStore
    * @name db
    */
  db: function(){
    let that = this;
    let {promise, resolve} = defer();
    // TODO each EventStore has different Db, so the createObjectStore will work.  Is this gross?
    let request = indexedDB.open("micropilot-"+that.collection,1);
    request.onerror = requestError;
    request.onupgradeneeded = function (event) {
      let objectStore = request.result.createObjectStore(that.collection,
        {keyPath: that.keyname, autoIncrement: true });
    };
    // called after onupgradeneeded
    request.onsuccess = function(event) {
      resolve(request.result);
    };
    return promise
  },
  /** promises to add data to the autoincrementing objectStore.
    *
    * Resolves on success with (`{id: newkey, data:data}`)
    *
    * @param {object} data jsonable data
    *
    * @memberOf EventStore
    * @name add
    */
  add: function(data){
    let that = this;
    let {promise, resolve} = defer();
    this.db().then(function(db){
      let request = db.transaction([that.collection], "readwrite").
        objectStore(that.collection).add(data);
      request.onsuccess = function (evt) {
        let newkey = evt.target.result;
        resolve({id: newkey, data:data});
      };
      request.onerror = requestError;
    })
    return promise
  },
  /** promise all data from the collection (async).
    *
    * Resolves on success (`data`).
    *
    * *Note*: non-blocking, only guarantees complete list of data if all
    * writes have finished.
    *
    * @memberOf EventStor
    * @name getAll
    */
  getAll: function(){
    // using getAll() doesn't seem to work, and isn't cross-platform
    let {promise, resolve} = defer();
    let that = this;
    this.db().then(function(db){
      let data = [];
      let req = db.transaction([that.collection], "readonly").objectStore(that.collection).openCursor()
      req.onsuccess = function(event) {
        let cursor = event.target.result;
        if (cursor) {
          data.push(cursor.value);
          cursor.continue();
        }
        else {
          resolve(data);
        }
      };
      req.onerror = requestError;
    })
    return promise;
  },
  /** promise to drop the database.
    *
    * Resolves onsuccess (`request.result`)
    * @memberOf EventStore
    * @name clear
    */
  clear: function(){
    let that = this;
    let {promise, resolve} = defer();
    let request = indexedDB.deleteDatabase("micropilot-"+that.collection,1);
    request.onerror = requestError;
    // called after onupgradeneeded
    request.onsuccess = function(event) {
      resolve(request.result);
    };
    return promise;
  }
});

/**
  * Micropilot Heritage Object
  *
  * Persists over multiple runs.
  * (Persistence achieved using `simple-store`, which ties a Micropilot into
  * a particular addon)
  *
  * @param {string} studyid unique key to id the study (used by dbs, prefs)
  * @module Micropilot
  *
  * @returns Micropilot instance
  */
let Micropilot = exports.Micropilot = Class({
  /** Initialize the Micropilot
    *
    * internals:
    *
    * * `_watched`: observed topics
    * * `eventstore`: an EventStore
    * * `_config`: simple-store configuration
    *   * `personid`:  a `uu()`  (set this if you want.)
    *   * `_startdate`:  now, or then (if revived)
    * * `isrunning`:  a brake on event recording
    *
    * @memberOf Micropilot
    * @name initialize
    */
  initialize: function(studyid){
      // setup the indexdb
      this.studyid = studyid;
      this._watched = {};
      this.eventstore = EventStore(this.studyid);
      this._config = storage.micropilot[studyid]; // persists
      if (this._config === undefined) {
        this._config = {};
        this._config.personid = uu();
      }
      this._startdate = this._config.startdate = Date.now(); // start now
      this.isrunning = true; // starts running by default
  },
  type: 'Micropilot',


  /** get and set the startDate
    *
    * @memberOf Micropilot
    * @name startdate
    */
  get startdate() this._startdate,
  // resetting the startdate kills existing run / fuse
  set startdate(ts) {
    this.stop();
    this._startdate = ts;
  },
  /** promise of all recorded event data
    *
    * Resolve (`data`)
    * @memberOf Micropilot
    * @name data
    */
  data: function() this.eventstore.getAll(),

  /** promise to clear all data (by dropping the db)
    *
    * Resolve(`request.response`) // of the dropDatabse
    * @memberOf Micropilot
    * @name clear
    */
  clear: function(){
    return this.eventstore.clear();
  },

  /** promise of `EventStore.add`, which is {id:<>,data:<>}
    * unless record "doesn't happen" because of private browsing or non-running
    *
    * @memberOf Micropilot
    * @name record
    */
  record: function(data){
    // TODO, what should these branches return?
    if (! this.isrunning) return resolve(undefined);
    if (pb.isActive) return resolve(undefined);  // respect private browsing

    // todo, what if it's not jsonable?
    JSON.stringify(data);
    myprefs.logtoconsole && console.log("RECORDING:", JSON.stringify(data));
    return resolve(this.eventstore.add(data));
  },

  /** promise the study (setting a Fuse)
    *
    *
    * Fuse set as {start: this.startdate,duration:duration}
    * (modify startdate to 'run from some other time')
    *
    * False or Undefined duration runs forever.
    *
    * Resolves when the study fuse resolves.
    *
    * example:
    *
    *   `Micropilot('mystudy').run(1000).then(function(mtp){mtp.stop()})`
    *
    * @param {integer} duration milliseconds to run Fuse
    * @memberOf Micropilot
    * @name run
    *
    */
  run:  function(duration){
    this.stop();
    this.isrunning = true; // restart!
    let deferred = defer();
    let that = this;
    // iff!
    if (duration){
      // should this allow / mix all fuse options?
      this.fuse = Fuse({start: this.startdate,duration:duration});
      return this.fuse;
    } else {
      // no duration, so infinite, so nothing to resolve.
    }
    return deferred.promise;
  },

  /** stop the study (unset the fuse, `this.running` -> `false`)
    *
    * (after stopping, `record` will not work, unless one `run()` or
    * or `isrunning` -> `true`)
    *
    * @return {micropilot} this
    * @memberOf Micropilot
    * @name stop
    */
  stop:  function(){
    this.isrunning = false;
    this.fuse !== undefined && this.fuse.stop();
    delete this.fuse;
    return this;
  },

  /** (internal) watch a topic, add to `observer-service`
   *
   * @param {string} topic topic to watch.
   * @memberOf Micropilot
   * @name _watch
   */
  _watch: function(topic){
    if (this._watched[topic]) return

    let that = this;
    let cb = this._watchfn || function(subject) {that.record(subject)}; // recording.
    let o = observer.add(topic,cb); // add to global watch list
    this._watched[topic] = cb;
  },

  /** add topics to watch (non-destructive)
    *
    * @param {array} watch_list list of topics
    * @return {micropilot} this
    * @memberOf Micropilot
    * @name watch
    */
  watch: function(watch_list){
      let that = this;
      watch_list.forEach(function(t) that._watch(t))
      return this;
  },

  /** (internal) stop watching topic
    * @memberOf Micropilot
    * @name _unwatch
    */
  _unwatch: function(topic){
    let cb = this._watched[topic];
    cb && observer.remove(topic,cb);
    delete this._watched[topic];
  },

  /** unwatch some topics (destructive)
    * if `unwatch_list` is undefined, unwatch all.
    *
    * @param {array} unwatch_list list of topics to remove.  If undefined, unwatch all.
    * @memberOf Micropilot
    * @name unwatch
    */
  unwatch: function(unwatch_list){
    if (unwatch_list === undefined) unwatch_list = Object.keys(this._watched);
    let that = this;
    unwatch_list.forEach(function(t) that._unwatch(t));
    return this;
  },
  /** promise simplified upload with strong opinions and retry semantics
    *
    * Options:
    *
    * - `url`:  defaults to `UPLOAD_URL + mtp.studyname`
    * - `maxtries`:  Number of tries.  (`3`)
    * - `interval`:  How long to wait between tries (60 min - `60*60*1000`)
    * - `killaddon`:  Should the addon delete itself on completion? (`false`)
    *
    * *Note 1*:  https://github.com/gregglind/micropilot/issues/2
    *
    * *Note 2*:  `_config.completed` will will go to `true` on success or not.
    *
    * *Note 3*:  Adds some keys to `_config` persistence:
    *
    * - `completed`
    * - `uploadcounter`
    *
    * This is Subject To Change, and just a starting point for how to talk
    * about study state.
    *
    * @param {Object} options Upload options.
    * @memberOf Micropilot
    * @name ezupload
    */
  ezupload: function(options){
    let { promise, resolve } = defer();
    let {url,maxtries,interval,killaddon:killpref} = options;
    let that = this;
    url = url || UPLOAD_URL + mtp.studyname;
    maxtries = maxtries || 3
    interval = interval || 60 * 60 * 1000; // 60 minutes

    let mycleanup = function(){
        that._config.completed = true ; // whatever properties you want
        let p = that.stop()
        p = that.clear();
        if (killpref) {
          resolve(p.then(killaddon));   // stop the study, clear the data, uninstall the addon.
        } else {
          resolve(p)
        }
    }

    if (this._config.uploadcounter === undefined) this._config.uploadcounter = 0;
    let myupload = function() {
      if (that._config.uploadcounter >= maxtries) { mycleanup(that); return};  // give up!
      that._config.uploadcounter += 1;
      that.upload(url).then(function(response){
        if (response.status != "200") {  // try again in interval ms
          require('timers').setTimeout(function(){myupload()}, interval)
        } else {
          mycleanup();
        }
      })
    }
    myupload();
    return promise;
  },

  /** promise to upload the data
    *
    * Options:
    * - `simulate`:  don't post, promise the request
    * - `uploadid`:  an id for the upload
    *
    * Resolves
    * - if POST, after oncomplete (response)
    * - if `options.simulate` (request)
    *
    * @param {string} url url to POST.
    * @param {object} options some options, below.
    * @memberOf Micropilot
    * @name upload
    */
  upload:  function(url,options){
    // get all... is this tangled between getting and posting?
    // attempt to post
    options = options===undefined ? {} : options;
    let that = this;
    let simulate = options.simulate;
    let { promise, resolve } = defer();
    let uploadid = options.uploadid || uu(); // specific to the upload
    this.data().then(function(data){
      let payload = {events:data};
      payload.userdata = snoop();
      payload.ts = Date.now();
      payload.uploadid = uploadid;
      payload.personid = that._config.personid;
      let R = Request({
        url: url,
        content: payload,
        contentType: "application/json",
        onComplete: function (response) {
          resolve(response) }
      });
      if (simulate) {
        resolve(R);
      } else {
        R.post();
      }
    });
    return promise;
  }

});

/** gather general user data, including addons, os, etc.
  *
  * Properties:  appname, location, fxVersion, os, updateChannel, addons
  * Returns {object} userdata
  * @name snoop
  */
let snoop = exports.snoop = function(){
  let LOCALE_PREF = "general.useragent.locale";
  let UPDATE_CHANNEL_PREF = "app.update.channel";
  let xa = require("xul-app");
  let prefs = require('preferences-service');

  let u = {};
  u.appname = xa.name;
  u.location = prefs.get(LOCALE_PREF)
  u.fxVersion = xa.version;
  u.os = require('runtime').os;
  u.updateChannel = prefs.get(UPDATE_CHANNEL_PREF)
  u.addons = [] // get this in some sync way? or move this all to async?
  return u;
}

/** Fuse Heritage Class
  *
  * @module Fuse
  */
let Fuse = exports.Fuse = Class({
  /**
    * Fuses trigger (resolve their promise) no sooner than `duration + start`
    *
    * (like a dynamite fuse)
    *
    * Options:
    *
    * - `start`:  start time for the fuse
    * - `duration`: how long to run.
    * - `pulseinterval`:  if defined, use a `setInterval` timer (see below)
    * - `resolve_this`:  the `this` passed into the `then` during resolution
    * - `pulsefn`:  if `setInterval` timer, run this function during every `pulse`
    *
    * `setInterval` vs. `setTimeout`:  Fuse is normally a `setTimeout`.  If you
    * want finer control over it (including being able to modify the timers of
    * running Fuses), use `pulseInterval` to make a `setInterval` timer.
    *
    * Note 1: "Short Fuses":  When the `duration` is very short, we don't guaranteed
    * millisecond accuracy!
    *
    * Note 2:  Restart.  If a Fuse 'should fire' while Firefox is not running,
    * it will fire the next time it can.
    *
    * Note 3:  Blast from the Past.  Fuses fire IFF
    *
    *   ```
    *   Date.now() >= (that.start + that.duration)
    *   ```
    *
    * Note 4: Persist a fuse over restarts.
    *
    * ```
    *   let {storage} = require("simple-storage");
    *   if (! storage.firststart) ss.firststart = Date.now(); // tied to addon
    *   Fuse({start: storeage.firststart,duration:86400 * 7 * 1000 }).then(
    *    function(){ Micropilot('delayedstudy').run()} )
    * ```
    *
    * @memberOf Fuse
    * @param {Object} options
    * @returns Fuse instance
    * @name initialize
    */
  initialize: function(options){
    let {start,duration,pulseinterval,resolve_this,pulsefn} = options;
    if (resolve_this === undefined) resolve_this = this;
    this.pulseinterval =  pulseinterval;
    let that = this;
    this.start = start;
    this.duration = duration;
    let { promise, resolve } = defer();
    this.promise = promise;
    this.resolve = resolve;
    // should this be setInterval, or setTimeout?
    // setInterval allows one to modify the fuse while running
    // more easily, but setTimeout is much more precise.
    if (pulseinterval){
      this.timerid = timers.setInterval(function(){
        that.checking = true;
        if (pulsefn) {pulsefn(that)}
        if (! duration) return;
        if (Date.now() >= (that.start + that.duration)){
          that.resolve(that.resolve_this);
          that.stop();
        }
        that.checking=false;
      },pulseinterval);
    } else {
      // TODO, what is setTimeout on a negative?
      that.checking=false;
      let timerunningsofar = (Date.now() - this.start);
      if (duration <= timerunningsofar) { // really short intervals
        this.resolve(resolve_this);
        this.stop();
      } else {
        this.timerid = timers.setTimeout(function(){
          that.resolve(that.resolve_this);
          that.stop();
        }, duration - timerunningsofar);
      }
    }
  },
  /** promise the promise.  Resolves with `resolve_this`
    *
    * @memberOf Fuse
    * @name then
    */
  get then() this.promise.then,

  type: 'Fuse',
  /** stop the fuse (clear the timeout).
    *
    * @return {fuse} this
    * @memberOf Fuse
    * @name stop
    */
  stop: function(){
    if (this.timerid) timers.clearTimeout(this.timerid);
    return this;
  }
});


/** Self-destruct (uninstall) this addon
  *
  * @memberOf main
  * @name killaddon
  */
let killaddon = exports.killaddon = function(){
  let id = require('self').id;
  require("sdk/addon/installer").uninstall(id);
}
