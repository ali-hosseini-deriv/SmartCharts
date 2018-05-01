import NotificationStore from '../store/NotificationStore';
import {TickHistoryFormatter} from './TickHistoryFormatter';
import Subscription from '../../app/connection/Subscription';

class Feed {
    constructor(binaryApi, cxx, mainStore) {
        this._cxx = cxx;
        this._binaryApi = binaryApi;
        this._streams = {};
        this._mainStore = mainStore;
    }

    // although not used, subscribe is overriden so that unsubscribe will be called by ChartIQ
    subscribe() {}

    // Do not call explicitly! Method below is called by ChartIQ when unsubscribing symbols.
    unsubscribe(symObj) {
        const key = this._getStreamKey(symObj);
        if (this._streams[key]) {
            this._binaryApi.forget(this._streams[key]);
            delete this._streams[key];
        }
    }

    _getStreamKey({ symbol, period, interval }) {
        return JSON.stringify({ symbol, period, interval });
    }

    async fetchInitialData(symbol, suggestedStartDate, suggestedEndDate, params, callback) {
        const { period, interval, symbolObject } = params;
        const key = this._getStreamKey(params);
        const isComparisonChart = this._cxx.chart.symbol !== symbol;
        const comparisonChartSymbol = isComparisonChart ? symbol : undefined;

        const dataRequest = {
            symbol,
            granularity: Feed.calculateGranularity(period, interval)
        };

        let cb = undefined;
        let response = await new Promise((resolve) => {
            const processTick = (comparisonSymbol) => {
                let hasHistory = false;
                return resp => {
                    if (hasHistory) {
                        const quotes = [TickHistoryFormatter.formatTick(resp)];

                        if (comparisonSymbol) {
                            CIQ.addMemberToMasterdata({
                                stx: this._cxx,
                                label: comparisonSymbol,
                                data: quotes,
                                createObject: true,
                            });
                        } else {
                            this._cxx.updateChartData(quotes);
                        }
                        return;
                    }
                    resolve(resp);
                    hasHistory = true;
                };
            };
            cb = processTick(comparisonChartSymbol);

            this._binaryApi.subscribeTickHistory(dataRequest, cb);
        });

        // Clear all notifications related to active symbols
        this._mainStore.notification.removeByCategory('activesymbol');

        if (response.error) {
            const errorCode = response.error.code;
            if (/^(MarketIsClosed|NoRealtimeQuotes)$/.test(errorCode)) {
                response = await this._binaryApi.getTickHistory(dataRequest);
                this._mainStore.notification.notify({
                    text: t.translate('[symbol] market is presently closed.', { symbol: symbolObject.name }),
                    category: 'activesymbol',
                });
            } else if (errorCode === 'StreamingNotAllowed') {
                if (!isComparisonChart) {
                    this._mainStore.chart.isChartAvailable = false;
                }
                this._mainStore.notification.notify({
                    text: t.translate('Streaming for [symbol] is not available due to license restrictions', { symbol: symbolObject.name }),
                    type: NotificationStore.TYPE_ERROR,
                    category: 'activesymbol',
                });
                callback({ quotes: [] });
                return;
            }
        } else {
            this._streams[key] = cb;
        }

        const quotes = TickHistoryFormatter.formatHistory(response);
        callback({ quotes });
        if (!isComparisonChart) {
            this._mainStore.chart.isChartAvailable = true;
        }
    }

    async fetchPaginationData(symbol, suggestedStartDate, endDate, params, callback) {
        const start = suggestedStartDate.getTime() / 1000;
        const end = endDate.getTime() / 1000;
        const now = (new Date().getTime() / 1000) | 0;
        const startLimit = now - (2.8 * 365 * 24 * 60 * 60);
        const { period, interval } = params;

        let result = { quotes: [] };
        if (end > startLimit) {
            try {
                const response = await this._binaryApi.getTickHistory({
                    symbol,
                    granularity: Feed.calculateGranularity(period, interval),
                    start: Math.max(start, startLimit),
                    end,
                });
                result.quotes = TickHistoryFormatter.formatHistory(response);
            } catch (err) {
                console.error(err); // eslint-disable-line
                result.quotes = { error: err };
            }
        }

        callback(result);
    }

    static calculateGranularity(period, interval) {
        const toSeconds = {
            second: 0,
            minute: 60,
            day: 24 * 60 * 60,
        };

        return toSeconds[interval] * period;
    }
}


export default Feed;
