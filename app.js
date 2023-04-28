const express = require(`express`);
const path = require(`path`);
const logger = require(`morgan`);
const wrap = require(`express-async-wrap`);
const _ = require(`lodash`);
const uuid = require(`uuid-by-string`);
const spacetime = require(`spacetime`);
const {DateTime,Interval} = require("luxon");
const ISO6391 = require('iso-639-1');

const getYearRange = filter => {
    let fromYear = parseInt(filter.from);
    let numYears = parseInt(filter.numYears);

    if (_.isNaN(fromYear)) {
        fromYear = new Date().getFullYear();
    }
    if (_.isNaN(numYears)) {
        numYears = 1;
    } else if (numYears < 1) {
        numYears = 1;
    }

    const yearRange = [fromYear, fromYear + numYears - 1];
    return yearRange;
};

const app = express();
app.use(logger(`dev`));
app.use(express.json());
app.use(express.urlencoded({
    extended: false
}));

app.get(`/logo`, (req, res) => res.sendFile(path.resolve(__dirname, `logo.svg`)));

const appConfig = require(`./config.app.json`);
app.get(`/`, (req, res) => res.json(appConfig));

app.post(`/validate`, (req, res) => res.json({
    name: `Public`
}));

const syncConfig = require(`./config.sync.json`);
app.post(`/api/v1/synchronizer/config`, (req, res) => res.json(syncConfig));

const schema = require(`./schema.json`);
app.post(`/api/v1/synchronizer/schema`, (req, res) => res.json(schema));

function getTitle(name) {
    let s = spacetime('2000', name);
    return {
        title: s.timezone().name,
        value: name
    };
}

app.post(`/api/v1/synchronizer/datalist`, wrap(async (req, res) => {

    const {
        types,
        account,
        field,
        dependsOn
    } = req.body;

    if (field == 'timezone') {
        let tzs = spacetime().timezones;
        let temp = Object.keys(tzs);
        temp = temp.map(getTitle);
        const items = temp.sort((a, b) => (a.title > b.title) ? 1 : -1);
        /*
        // not working, don't know why
        const timezones = Intl.supportedValuesOf('timeZone');
        const items = timezones.map((tz) => ({title:tz, value:tz}));
        */
        res.json({
            items
        });
    }
    if (field == 'locale') {
        const ISO6391 = require('iso-639-1');
        const codes = require('iso-lang-codes');
        let locales = codes.locales();
        let localeNames = Object.keys(locales);
        const items = localeNames.map((l) => ({
            "title": ISO6391.getNativeName(l.substring(0, 2)) + " (" + l + ")",
            "value": l
        }));
        res.json({
            items
        });
    }
    if (field == 'types') {
        const items = [{
            title: "Days",
            value: "Day"
        }, {
            title: "Weeks",
            value: "Week"
        }, {
            title: "Months",
            value: "Month"
        }, {
            title: "Quarters",
            value: "Quarter"
        }, {
            title: "Years",
            value: "Year"
        }];
        res.json({
            items
        });
    }
}));

function customSort(array) {

    array = array.sort(function(a, b) {
        return (a.length < b.length) ? -1 : (a.length > b.length) ? 1 : 0;
    });

    var yearIndex = array.indexOf('Year');
    if (yearIndex > -1) {
        array.push(array.splice(yearIndex, 1)[0]);
    }

    return array;
}

app.post(`/api/v1/synchronizer/data`, wrap(async (req, res) => {
    const {
        requestedType,
        filter
    } = req.body;
    if (requestedType !== `period`) {
        throw new Error(`Only this database can be synchronized`);
    }
    const {
        timezone,
        locale,
        types
    } = filter;
    const yearRange = getYearRange(filter);

    if (requestedType == `period`) {
        const start = yearRange[0] + '/01/01';
        const end = yearRange[1] + '/12/31';

        let s = DateTime.fromFormat(start, 'yyyy/MM/dd');
        s = s.startOf('day');
        s = s.setZone(timezone, {
            keepLocalTime: true
        });
        let e = DateTime.fromFormat(end, 'yyyy/MM/dd');
        e = e.startOf('day');
        e = e.setZone(timezone, {
            keepLocalTime: true
        });
        const n = DateTime.local({
            zone: timezone
        });

        let choices = [];

        if (types === undefined) {
            choices = ["Day", "Week", "Month", "Quarter", "Year"];
        } else {
            choices = customSort(types);
        }

        let items = [];

        choices.forEach((type) => {

            const types = type.toLowerCase() + 's';
            let d = s.startOf(type).setLocale(locale);
            const startOfThis = n.startOf(type);

            let i = Interval.fromDateTimes(d, d.endOf(type));

            const endDate = e.plus({
                [types]: 1
            });

            while (i.isBefore(endDate)) {
                let item = {};
                item.type = type;

                const dates = {
                    start: i.start.toFormat('yyyy-MM-dd'),
                    end: i.end.plus({
                        'days': 1
                    }).toFormat('yyyy-MM-dd')
                };
                item.dates = JSON.stringify(dates);

                let delta = 0;
                
                if (startOfThis > d) { // in the past
                    const diff = Interval.fromDateTimes(d,startOfThis);
                    delta = 0-diff.length(types);
                }
                else {
                    const diff = Interval.fromDateTimes(startOfThis,d);
                    delta = diff.length(types);
                }
                
                item.relative = delta;
                
                /*
                let relativeStr = d.toRelative({
                    base: startOfThis,
                    unit: types
                });
                var r = /\d+/;
                const delta = parseInt(relativeStr.match(r), 10);
                if (d < startOfThis) {
                    item.relative = 0 - delta
                } else {
                    item.relative = delta
                };
                */             
                
                let semanticStr = d.toRelativeCalendar({
                    base: startOfThis,
                    unit: types
                });
                item.semantic = semanticStr;

                switch (type) {
                    case 'Day':
                        item.number = d.ordinal;
                        item.name = d.toLocaleString();
                        item.dotw = d.weekdayLong;
                        break
                    case 'Week':
                        item.number = d.weekNumber;
                        item.name = d.weekYear.toString() + "-W" + d.weekNumber.toString().padStart(2, '0');
                        break
                    case 'Month':
                        item.number = d.month;
                        item.name = d.monthShort + " " + d.year.toString();
                        break
                    case 'Quarter':
                        item.number = d.quarter;
                        item.name = d.year + "-Q" + d.quarter;
                        break
                    case 'Year':
                        item.number = d.year;
                        item.name = d.year.toString();
                        break
                    default:
                }

                if (Math.abs(delta) <= 1) {
                    item.name = item.name + " (" + item.semantic + ")";
                }

                function isInType(arrayOfTypes, arrayToFill, interval) {
                    let matchType = arrayOfTypes.pop();
                    if (type !== matchType) {
                        let matchS = uuid(JSON.stringify(Interval.fromDateTimes(interval.start.startOf(matchType), interval.start.endOf(matchType)).toFormat('yyyy/MM/dd')));
                        if (arrayToFill.indexOf(matchS) === -1) {
                            arrayToFill.push(matchS);
                        }
                        let matchE = uuid(JSON.stringify(Interval.fromDateTimes(interval.end.startOf(matchType), interval.end.endOf(matchType)).toFormat('yyyy/MM/dd')));

                        if (arrayToFill.indexOf(matchE) === -1) {
                            arrayToFill.push(matchE);
                        }

                        if (arrayOfTypes.length > 0) {
                            isInType(arrayOfTypes, arrayToFill, interval);
                        }
                    }
                    return arrayToFill
                }

                let matchingTypes = [...choices];
                matchingTypes.shift();
                let isIn = [];
                if (matchingTypes.length > 0) {
                    item.is_in = isInType(matchingTypes, isIn, i);
                }
                let composeTypes = [...choices];

                while (composeTypes.length > 1) {
                    let findType = composeTypes.shift();
                    if (type == findType) {
                        let matchType = composeTypes[0];
                        let intervalMid = (i.divideEqually(2))[0].end;
                        item.part_of = uuid(JSON.stringify(Interval.fromDateTimes(intervalMid.startOf(matchType), intervalMid.endOf(matchType)).toFormat('yyyy/MM/dd')));
                    }
                }

                item.id = uuid(JSON.stringify(i.toFormat('yyyy/MM/dd')));

                //let prevID = ''
                //item.previous = prevID;
                //prevID = item.id
                //item.scratch = d.locale;
                //item.scratch1 = choices.map((t) => t.order);
                //item.scratch2 = choices;

                items.push(item);

                d = d.plus({
                    [types]: 1
                });
                i = Interval.fromDateTimes(d, d.endOf(type));
            }
        });

        return res.json({
            items
        });
    }
}));

app.use(function(req, res, next) {
    const error = new Error(`Not found`);
    error.status = 404;
    next(error);
});

app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    console.log(err);
    res.json({
        message: err.message,
        code: err.status || 500
    });
});

module.exports = app;
