var aws    = require('aws-sdk');
var async  = require('async');
var byline       = require('byline');
var util         = require('util');
var EventEmitter = require('events').EventEmitter;
var strftime     = require('strftime');

var Parallel_Limit = 24;
var s3 = new aws.S3();

// !!! FIXME: these should be options with defaults, the date format + stage +
// hostname needs to be more fixed in S3StreamLogger, or we need to be able to
// cope without stages/hostnames here
var Date_Format_Prefix = "%Y-%m-%d-%H-%M";
var File_Poll_Millis = 5000;
var Far_Future = new Date(9000,0,0,0,0,0,0);
var Data_Delay_Millis = 20000;

function bucketDateFormat(date){
    return strftime(Date_Format_Prefix, date);
}

function hostFromFilename(fname){
    var has_seconds   = /^\d*-\d*-\d*-\d*-\d*-\d*-(.*)\.log$/.exec(fname);
    var lacks_seconds = /^\d*-\d*-\d*-\d*-\d*-(.*)\.log$/.exec(fname);
    return (has_seconds || lacks_seconds)[1];
}

function dateFromFilename(fname){
    var has_seconds   =  /^(\d*-\d*-\d*-\d*-\d*-\d*)-.*\.log$/.exec(fname);
    var lacks_seconds =  /^(\d*-\d*-\d*-\d*-\d*)-.*\.log$/.exec(fname);
    return (has_seconds || lacks_seconds)[1];
}

function asUTC(d){
    return new Date(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds()
    );
}

function listWithPrefix(bucket, prefix, delimiter, callback){
    // console.log("list:", bucket, prefix, delimiter);
    return s3.listObjects({
        Bucket: bucket,
        Delimiter: delimiter,
        Prefix: prefix
    }, callback);
}

function inRange(start, prefix, end){
    // lexicographical comparison of truncated strings suffices
    return prefix >= start.substr(0, prefix.length) && prefix <= end.substr(0, prefix.length);
}

function compareTS(a, b){
    if(a.timestamp < b.timestamp){
        return -1;
    }else if(a.timestamp > b.timestamp){
        return 1;
    }else{
        return 0;
    }
}

function getFiles(in_bucket, from, to, with_stage, callback){
    
    function matchPredicate(predicate, pass_through_failed_matches){
        // if pass_through_failed_matches is set, only extend the prefixes if
        // they matched, and pass through everything that failed (nothing is
        // actually rejected by such a predicate, things that failed are
        // returned unmodified)
        return function matchPrefixes(prefixes, callback){
            if(typeof callback === 'undefined'){
                callback = prefixes;
                prefixes = [''];
            }
            var next_prefixes = [];
            async.eachLimit(prefixes, Parallel_Limit, function(prefix, cb){
                listWithPrefix(in_bucket, prefix, '-', function(err, data){
                    if(err) return cb(err);
                    var matching_prefixes = data.CommonPrefixes
                        .map(function(x){return x.Prefix})
                        .filter(predicate);
                    next_prefixes = next_prefixes.concat(matching_prefixes);
                    cb(null);
                });
            }, function(err){
                if(err) return callback(err);
                if(pass_through_failed_matches){
                    next_prefixes = next_prefixes.concat(prefixes);
                }
                next_prefixes.sort();
                callback(null, next_prefixes);
            });
        }
    }

    function getAll(prefixes, callback){
        var all = [];
        async.eachLimit(prefixes, Parallel_Limit, function(prefix, cb){
            listWithPrefix(in_bucket, prefix, undefined, function(err, data){
                if(err) return cb(err);
                var matching_prefixes = data.Contents
                    .map(function(x){return x.Key});
                all = all.concat(matching_prefixes);
                cb(null);
            });
        }, function(err){
            if(err) return callback(err);
            all.sort();
            callback(null, all);
        });
    }

    var matchNextPart = matchPredicate(function(x){
        return inRange(from, x, to);
    });

    var matchSecondsIfPresent = matchPredicate(function(x){
        return !!(/.*-[0-6][0-9]-$/.exec(x));
    }, true);

    var matchStage = matchPredicate(function(x){
        return x.indexOf(with_stage, x.length - with_stage.length - 1) != -1;
    });

    async.waterfall([
        matchNextPart, // match years
        matchNextPart, // match months
        matchNextPart, // match days
        matchNextPart, // match hours
        matchNextPart, // match minutes
        matchSecondsIfPresent, // match seconds if present in timestamp
        matchStage,    // match the stage
        getAll,        // get everything that matches
    ], callback);
}

function BucketFileStream(bucket, since, with_stage, until){
    if(!(this instanceof BucketFileStream))
        return new BucketFileStream(bucket, since, with_stage);

    this.bucket = bucket;
    this.stage  = with_stage;
    this.since  = since;
    this.until  = until || Far_Future;
    this.until_formatted = bucketDateFormat(this.until);
    this.active_files = {};

    this.checkForNewFiles(true);
}
util.inherits(BucketFileStream, EventEmitter);

BucketFileStream.prototype.checkForNewFiles = function(all){
    // find the oldest active file, and use it as the start of a new poll
    var self = this;
    var oldest;
    var since_formatted;
    Object.keys(this.active_files).forEach(function(host){
        if((!oldest) || self.active_files[host] < oldest){
            oldest = self.active_files[host];
        }
    });
    if(!oldest){
        since_formatted = bucketDateFormat(asUTC(self.since));
    }else{
        since_formatted = dateFromFilename(oldest);
    }
    
    getFiles(this.bucket, since_formatted, this.until_formatted, this.stage, function(err, files){
        if(err) return self.emit('error', err);

        files.forEach(function(f){
            if(all)
                self.emit('file', f);
            var host = hostFromFilename(f);
            if((!self.active_files.hasOwnProperty(host)) || dateFromFilename(self.active_files[host]) < dateFromFilename(f)){
                if(!all)
                    self.emit('file', f);
                self.active_files[host] = f;
            }
        });

        // we've reached the end of all the files for the specified time range
        // if 'now' is greater than 'until' (since getFiles enumerated all
        // existing files).
        if(bucketDateFormat(asUTC(new Date())) > self.until_formatted){
            self.emit('end');
            return;
        }

        setTimeout(self.checkForNewFiles.bind(self), File_Poll_Millis);
    });
};


function BucketDataStream(bucket, since, with_stage, until){
    if(!(this instanceof BucketDataStream))
        return new BucketDataStream(bucket, since, with_stage);

    var self = this;

    // need to get files up to an hour older than the time we care about, as
    // files can contain hour-old data
    this.file_stream = new BucketFileStream(bucket, new Date(since.getTime() - 3600000), with_stage, until);

    this.active_files = {};   // hostname : last line
    this.poll_filenames = {}; // filename : 1
    this.lines_read = {};
    this.lines = [];
    this.since = since;
    this.until = until;
    this.bucket = bucket;
    this.start_emitting = false;
    this.ending = false;

    this.getting_files = 0;

    this.file_stream.on('file', this.onFile.bind(this));
    this.file_stream.on('error', function(err){self.emit('error', err);});
    this.file_stream.on('end', function(){
        self.ending = true;
    });

    // don't start emitting until we're fairly sure we've got the backlog of
    // data, otherwise the lines won't be correctly ordered (once we print a
    // line we're done with it)
    // (if we've got no outstanding requests before this time we start emitting
    // sooner)
    setTimeout(function(){
        self.start_emitting = true;
        self.emitAvailableLines();
    }, 120000);
}
util.inherits(BucketDataStream, EventEmitter);

BucketDataStream.prototype.onFile = function(file){
    var self = this;
    var host = hostFromFilename(file);
    // check if this file replaces an existing one:
    Object.keys(this.active_files).forEach(function(h){
        if(host === h){
            delete self.poll_filenames[self.active_files[host].full_name];
            self.pollFile(self.active_files[host].full_name);
        }
    });
    self.active_files[host] = {full_name:file};
    self.poll_filenames[file] = 1;
    self.lines_read[file] = 0;
    self.pollFile(file);
};

BucketDataStream.prototype.pollFile = function(file){
    // console.log('getFile', file);
    var self = this;

    this.getting_files++;
    var stream = byline(s3.getObject({
        Bucket: this.bucket, 
        Key: file
    }).createReadStream());

    var lines_read = 0;
    var error = null;

    stream.on('data', function(line){
        lines_read++;
        if(lines_read > self.lines_read[file]){
            var l = JSON.parse(line.toString('utf-8'));
            var ts = l.timestamp && (new Date(l.timestamp)).getTime();
            if((!ts) || (ts >= self.since.getTime() && ((!self.until) || ts < self.until.getTime())))
                self.lines.push(l);
            self.lines_read[file]++;
        }
    });
    stream.on('error', function(err){
        if(error) return;
        error = err || new Error();
        self.emit('error', err);
        self.getting_files--;
        self.emitAvailableLines();
    });
    stream.on('end', function(err){
        if(error) return;
        if(err){
            self.emit('error', err);
            error = err;
        }
        if(self.poll_filenames[file] && !self.ending)
            setTimeout(function(){self.pollFile(file);}, File_Poll_Millis);
        self.getting_files--;
        self.emitAvailableLines();
    });
};

BucketDataStream.prototype.emitAvailableLines = function(){
    if(this.getting_files && !this.start_emitting)
        return;
    // emit .line events for each line that we've received that we're pretty
    // sure has been received in order
    this.lines.sort(compareTS);
    var emit_before = (new Date()).getTime() - Data_Delay_Millis;
    var i;
    for(i = 0; i < this.lines.length; i++){
        if(!this.lines[i].timestamp){
            this.lines.emit('line', this.lines[i]);
        }else{
            var t = (new Date(this.lines[i].timestamp)).getTime();
            if(emit_before - t > Data_Delay_Millis){
                this.emit('line', this.lines[i]);
            }else{
                break;
            }
        }
    }
    this.lines = this.lines.slice(i);
    // if we've run out of new files, and emit_before has exceeded our
    // until-time, then we're done:
    if(this.ending && emit_before > this.until.getTime()){
        this.emit('end');
    }
};

module.exports = {
    getFiles: getFiles,
    bucketDateFormat: bucketDateFormat,
    BucketFileStream: BucketFileStream,
    BucketDataStream: BucketDataStream
};

