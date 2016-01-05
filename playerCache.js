var config = require('./config');
var zlib = require('zlib');
var compute = require('./compute');
var computePlayerMatchData = compute.computePlayerMatchData;
var aggregator = require('./aggregator');
var utility = require('./utility');
var reduceMatch = utility.reduceMatch;
var async = require('async');
var constants = require('./constants');
var enabled = config.ENABLE_PLAYER_CACHE;
var redis;
var cassandra;
if (enabled)
{
    redis = require('./redis');
    //cassandra = require('./cassandra');
}
//CREATE KEYSPACE yasp WITH REPLICATION = { 'class' : 'NetworkTopologyStrategy', 'datacenter1': 1 };
//CREATE TABLE yasp.player_caches (account_id bigint PRIMARY KEY, cache blob);
function readCache(account_id, cb)
{
    if (enabled)
    {
        console.time('readcache');
        redis.get(new Buffer("player:" + account_id), function(err, result)
        {
            var cache = result ? JSON.parse(zlib.inflateSync(result)) : null;
            console.timeEnd('readcache');
            return cb(err, cache);
        });
        /*
        var query = 'SELECT cache FROM player_caches WHERE account_id=?';
        cassandra.execute(query, [account_id],
        {
            prepare: true
        }, function(err, result)
        {
            result = result && result.rows && result.rows[0] ? result.rows[0].cache : null;
            
            var cache = result ? JSON.parse(zlib.inflateSync(result)) : null;
            console.timeEnd('readcache');
            return cb(err, cache);
        });
        */
    }
    else
    {
        return cb();
    }
}

function writeCache(account_id, cache, cb)
{
    if (enabled)
    {
        console.time("writecache");
        console.log("saving player cache %s", account_id);
        redis.ttl("player:" + account_id, function(err, ttl)
        {
            if (err)
            {
                return cb(err);
            }
            redis.setex(new Buffer("player:" + account_id), Number(ttl) > 0 ? Number(ttl) : 24 * 60 * 60 * config.UNTRACK_DAYS, zlib.deflateSync(JSON.stringify(cache)), function(err)
            {
                console.timeEnd("writecache");
                cb(err);
            });
        });
        /*
        cassandra.execute('SELECT TTL(cache) FROM player_caches WHERE account_id = ?', [account_id],
        {
            prepare: true
        }, function(err, result)
        {
            if (err)
            {
                return cb(err);
            }
            var ttl = result = result && result.rows && result.rows[0] ? result.rows[0]["TTL(cache)"] : null;
            console.log(result);
            var query = 'INSERT INTO player_caches (account_id, cache) VALUES (?, ?) USING TTL ?';
            cassandra.execute(query, [account_id, zlib.deflateSync(JSON.stringify(cache)), Number(ttl) > 0 ? Number(ttl) : 24 * 60 * 60 * config.UNTRACK_DAYS],
            {
                prepare: true
            }, function(err, result)
            {
                console.timeEnd("writecache");
                return cb(err);
            });
        });
        */
    }
    else
    {
        return cb();
    }
}

function updateCache(match, cb)
{
    if (enabled)
    {
        var players = match.players;
        if (match.pgroup && players)
        {
            players.forEach(function(p)
            {
                //add account id to each player so we know what caches to update
                p.account_id = match.pgroup[p.player_slot].account_id;
                //add hero_id to each player so we update records with hero played
                p.hero_id = match.pgroup[p.player_slot].hero_id;
            });
        }
        async.eachSeries(players, function(player_match, cb)
        {
            if (player_match.account_id && player_match.account_id !== constants.anonymous_account_id)
            {
                //join player with match to form player_match
                for (var key in match)
                {
                    player_match[key] = match[key];
                }
                readCache(player_match.account_id, function(err, cache)
                {
                    if (err)
                    {
                        return cb(err);
                    }
                    //if player cache doesn't exist, skip
                    if (cache)
                    {
                        var reInsert = player_match.match_id in cache.aggData.match_ids && player_match.insert_type === "api";
                        var reParse = player_match.match_id in cache.aggData.parsed_match_ids && player_match.insert_type === "parsed";
                        if (!reInsert && !reParse)
                        {
                            computePlayerMatchData(player_match);
                            cache.aggData = aggregator([player_match], player_match.insert_type, cache.aggData);
                        }
                        //reduce match to save cache space--we only need basic data per match for matches tab
                        var reduced_player_match = reduceMatch(player_match);
                        var identifier = [player_match.match_id, player_match.player_slot].join(':');
                        var found = false;
                        cache.data.forEach(function(m)
                        {
                            if (identifier === [m.match_id, m.player_slot].join(':'))
                            {
                                found = true;
                                //iterate instead of setting directly to avoid clobbering existing data
                                for (var key in reduced_player_match)
                                {
                                    m[key] = reduced_player_match[key] || m[key];
                                }
                            }
                        });
                        if (!found)
                        {
                            cache.data.push(reduced_player_match);
                        }
                        writeCache(player_match.account_id, cache, cb);
                    }
                    else
                    {
                        return cb();
                    }
                });
            }
            else
            {
                return cb();
            }
        }, cb);
    }
    else
    {
        return cb();
    }
}

function countPlayerCaches(cb)
{
    if (enabled)
    {
        redis.keys("player:*", function(err, result)
        {
            cb(err, result.length);
        });
        /*
        cassandra.execute('SELECT COUNT(*) FROM player_caches', [],
        {
            prepare: true
        }, function(err, result)
        {
            result = result && result.rows && result.rows[0] ? result.rows[0].count : 0;
            return cb(err, result.toNumber());
        });
        */
    }
    else
    {
        return cb(null, 0);
    }
}
module.exports = {
    readCache: readCache,
    writeCache: writeCache,
    updateCache: updateCache,
    countPlayerCaches: countPlayerCaches,
};