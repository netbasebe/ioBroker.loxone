/*
 * Created with @iobroker/create-adapter v1.26.0
 */

import * as utils from '@iobroker/adapter-core';
import * as LxCommunicator from 'lxcommunicator';
import { v4 } from 'uuid';
import { Unknown } from './controls/Unknown';
import { ControlBase, ControlType } from './controls/control-base';
import { Control, Controls, GlobalStates, OperatingModes, StructureFile, WeatherServer } from './structure-file';
import { WeatherServerHandler } from './weather-server-handler';
import Queue = require('queue-fifo');

const WebSocketConfig = LxCommunicator.WebSocketConfig;

export type OldStateValue = ioBroker.StateValue | null | undefined;
export type CurrentStateValue = ioBroker.StateValue | null;

export type StateChangeListener = (oldValue: OldStateValue, newValue: CurrentStateValue) => void;
export type StateChangeListenerOpts = {
    notIfEqual?: boolean; // Don't call if new/old vals are the same & automatically ack state change
    convertToInt?: boolean; // Convert state values to integers
    minInt?: number; // Values below minInt will be set to this value
    maxInt?: number; // Values above maxInt will be set to this value
    ackTimeoutMs?: number; // Override default timeout
    selfAck?: boolean; // Acknowledge ourself (don't wait for Loxone)
};
export type StateChangeListenEntry = {
    listener: StateChangeListener;
    opts?: StateChangeListenerOpts;
    queuedVal: ioBroker.StateValue | null;
    ackTimer: ioBroker.Timeout | undefined;
};
// Log warnings if no ack event from Loxone in this time
// TODO: should this be configurable?
const ackTimeoutMs = 500;

// Period between connection attempts
const reconnectTimeoutMs = 5000;

export type StateEventHandler = (value: any) => Promise<void>;
export type StateEventRegistration = { name?: string; handler: StateEventHandler };
export type NamedStateEventHandler = (id: string, value: any) => Promise<void>;
export type LoxoneEvent = { uuid: string; evt: any };

export type FormatInfoDetailsCallback = ((src: infoDetailsEntryMap) => ioBroker.StateValue) | null;
export type infoDetailsEntry = { count: number; lastValue?: any };
export type infoDetailsEntryMap = Map<string, infoDetailsEntry>;
export type InfoEntry = {
    value: ioBroker.StateValue;
    lastSet: ioBroker.StateValue;
    timer: ioBroker.Timeout | undefined;
    detailsMap?: infoDetailsEntryMap;
};

export class Loxone extends utils.Adapter {
    private uuid = '';
    private socket?: any;
    private existingObjects: Record<string, ioBroker.Object> = {};
    private currentStateValues: Record<string, CurrentStateValue> = {};
    private operatingModes: OperatingModes = {};
    private foundRooms: Record<string, string[]> = {};
    private foundCats: Record<string, string[]> = {};

    private stateChangeListeners: Record<string, StateChangeListenEntry> = {};
    private stateEventHandlers: Record<string, StateEventRegistration[]> = {};

    private readonly eventsQueue = new Queue<LoxoneEvent>();
    private runQueue = false;
    private queueRunning = false;

    public readonly reportedMissingControls = new Set<string>();
    private readonly reportedUnsupportedStateChanges = new Set<string>();
    private reconnectTimer?: ioBroker.Timeout;
    private connectionInProgress = false;
    private lxConnected = false;

    private info: Map<string, InfoEntry>;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            dirname: __dirname.indexOf('node_modules') !== -1 ? undefined : __dirname + '/../',
            ...options,
            name: 'loxone',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.info = new Map<string, InfoEntry>();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Init info
        await this.initInfoStates();

        // store all current (acknowledged) state values
        const allStates = await this.getStatesAsync('*');
        for (const id in allStates) {
            if (allStates[id] && allStates[id].ack) {
                this.currentStateValues[id] = allStates[id].val;
            }
        }

        // store all existing objects for later use
        this.existingObjects = await this.getAdapterObjectsAsync();

        // Reset the connection indicator during startup
        this.setConnectionState(false);
        this.uuid = v4();
        // connect to Loxone Miniserver
        const webSocketConfig = new WebSocketConfig(
            WebSocketConfig.protocol.WS,
            this.uuid,
            'iobroker',
            WebSocketConfig.permission.APP,
            false,
        );

        const handleAnyEvent = (uuid: string, evt: any): void => {
            this.log.silly(`received update event: ${JSON.stringify(evt)}: ${uuid}`);
            this.eventsQueue.enqueue({ uuid, evt });
            this.handleEventQueue().catch((e) => {
                this.log.error(`Unhandled error in event ${uuid}: ${e}`);
                // Error logged above
            });
        };

        webSocketConfig.delegate = {
            socketOnDataProgress: (socket: any, progress: any) => {
                this.log.debug('data progress ' + progress);
            },
            socketOnTokenConfirmed: (_socket: any, _response: any) => {
                this.log.debug('token confirmed');
            },
            socketOnTokenReceived: (_socket: any, _result: any) => {
                this.log.debug('token received');
            },
            socketOnConnectionClosed: (socket: any, code: string) => {
                this.log.info('Socket closed ' + code);
                this.setConnectionState(false);

                // Stop queue and clear it. Issue a warning if it isn't empty.
                this.runQueue = false;
                if (this.eventsQueue.size() > 0) {
                    this.log.warn('Event queue is not empty. Discarding ' + this.eventsQueue.size() + ' items');
                }
                // Yes - I know this could go in the 'if' above but here 'just in case' ;)
                this.eventsQueue.clear();

                if (code != LxCommunicator.SupportCode.WEBSOCKET_MANUAL_CLOSE) {
                    this.reconnect();
                }
            },
            socketOnEventReceived: (socket: any, events: any, type: number) => {
                this.log.silly(`socket event received ${type} ${JSON.stringify(events)}`);
                this.incInfoState('info.messagesReceived');
                for (const evt of events) {
                    switch (type) {
                        case LxCommunicator.BinaryEvent.Type.EVENT:
                            handleAnyEvent(evt.uuid, evt.value);
                            break;
                        case LxCommunicator.BinaryEvent.Type.EVENTTEXT:
                            handleAnyEvent(evt.uuid, evt.text);
                            break;
                        case LxCommunicator.BinaryEvent.Type.EVENT:
                            handleAnyEvent(evt.uuid, evt);
                            break;
                        case LxCommunicator.BinaryEvent.Type.WEATHER:
                            handleAnyEvent(evt.uuid, evt);
                            break;
                        default:
                            break;
                    }
                }
            },
        };
        this.socket = new LxCommunicator.WebSocket(webSocketConfig);

        await this.connect();

        this.subscribeStates('*');
    }

    private async loadStructureFile(): Promise<boolean> {
        let file: StructureFile;
        try {
            const fileString = await this.socket.send('data/LoxAPP3.json');
            file = JSON.parse(fileString);
        } catch (error) {
            // do not stringify error, it can contain circular references
            this.log.error(`Couldn't get structure file`);
            return false;
        }
        this.log.silly(`get_structure_file ${JSON.stringify(file)}`);
        this.log.info(`got structure file; last modified on ${file.lastModified}`);
        // Structure file loaded successfully

        try {
            await this.loadStructureFileAsync(file);
            this.log.debug('structure file successfully loaded');
        } catch (error) {
            // do not stringify error, it can contain circular references
            this.log.error(`Couldn't load structure file`);
            // Error logged above
            return false;
        }

        return true; // Success
    }

    private async connect(): Promise<void> {
        if (this.connectionInProgress) {
            this.log.warn('Connection already in progress');
        } else {
            this.log.info('Trying to connect');
            this.connectionInProgress = true;

            let success = true; // Assume success

            try {
                await this.socket.open(
                    this.config.host + ':' + this.config.port,
                    this.config.username,
                    this.config.password,
                );
            } catch (error) {
                // do not stringify error, it can contain circular references
                this.log.error(`Couldn't open socket`);
                success = false;
            }

            if (success) {
                success = await this.loadStructureFile();
            }

            if (success) {
                try {
                    await this.socket.send('jdev/sps/enablebinstatusupdate');
                } catch (error) {
                    // do not stringify error, it can contain circular references
                    this.log.error(`Couldn't enable status updates`);
                    success = false;
                }
            }

            this.connectionInProgress = false;

            if (!success) {
                this.log.debug('Connection failed - will retry after delay');
                if (this.socket) {
                    this.socket.close();
                }
                this.reconnect();
            } else {
                // We are ready, let's set the connection indicator
                this.setConnectionState(true);
            }
        }
    }

    private reconnect(): void {
        if (this.reconnectTimer) {
            this.log.debug('Reconnect called while timer already running');
        } else if (this.connectionInProgress) {
            this.log.debug('Reconnect called while connection in progress');
        } else {
            this.reconnectTimer = this.setTimeout(() => {
                delete this.reconnectTimer;
                this.connect().catch((e) => {
                    this.log.error(`Couldn't reconnect: ${e}`);
                    this.reconnect();
                });
            }, reconnectTimeoutMs);
        }
    }

    private setConnectionState(connected: boolean): void {
        this.lxConnected = connected;
        void this.setState('info.connection', this.lxConnected, true);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
            if (this.socket) {
                this.socket.close();
                delete this.socket;
            }
            callback();
        } catch (e) {
            callback();
        }
        this.flushInfoStates();
        // TODO: clear queued state change timers
    }

    /**
     * Is called if a subscribed state changes
     */
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        // Warning: state can be null if it was deleted!
        if (!id || !state || state.ack) {
            // Do nothing
        } else if (id.includes('.info.')) {
            // Ignore info changes
            // TODO: can this be done better by ignoring '.info.' in subscribeStates?
        } else {
            this.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);
            if (!this.stateChangeListeners.hasOwnProperty(id)) {
                const msg = 'Unsupported state change: ' + id;
                this.log.error(msg);
                if (!this.reportedUnsupportedStateChanges.has(id)) {
                    this.reportedUnsupportedStateChanges.add(id);
                    // Unsupported state change logged above
                }
            } else if (!this.lxConnected) {
                this.log.warn(`stateChange ${id} while disconnected, discarding`);
                this.incInfoState('info.stateChangesDiscarded');
            } else {
                const stateChangeListener = this.stateChangeListeners[id];
                if (stateChangeListener.ackTimer) {
                    // Ack timer is running: we didn't get a reply from the previous command yet
                    if (stateChangeListener.queuedVal !== null) {
                        // Already a queued state change: we're going to have to discard that and replace with latest
                        this.log.warn(
                            `State change in progress for ${id}, discarding ${stateChangeListener.queuedVal}`,
                        );
                        this.incInfoState('info.stateChangesDiscarded');
                    } else {
                        // Nothing queued, so this will only be delayed (at least for now)
                        this.log.warn(`State change in progress for ${id}, delaying ${state.val}`);
                        this.incInfoState('info.stateChangesDelayed');
                    }
                    stateChangeListener.queuedVal = state.val;
                } else {
                    // Ack timer is not running, so we're all good to handle this
                    await this.handleStateChange(id, stateChangeListener, state.val);
                }
            }
        }
    }

    public convertStateToInt(value: OldStateValue): number {
        return !value ? 0 : parseInt(value.toString());
    }

    private async handleStateChange(
        id: string,
        stateChangeListener: StateChangeListenEntry,
        val: ioBroker.StateValue,
    ): Promise<void> {
        if (stateChangeListener.opts?.convertToInt) {
            // Convert any values to ints within range if necessary.
            val = this.convertStateToInt(val);
            if (stateChangeListener.opts?.minInt !== undefined && val < stateChangeListener.opts.minInt) {
                val = stateChangeListener.opts.minInt;
            }
            if (stateChangeListener.opts?.maxInt !== undefined && val > stateChangeListener.opts.maxInt) {
                val = stateChangeListener.opts.maxInt;
            }
        }
        if (stateChangeListener.opts?.notIfEqual && this.currentStateValues[id] === val) {
            // new/old values are the same so don't send update.
            // However, ack the state change as we have 'handled' this (by doing nothing)
            this.log.debug(`State value is unchanged, no listener+self-ack: ${id} ${val}`);
            await this.setStateAck(id, val);
        } else {
            if (!stateChangeListener.opts?.selfAck) {
                // Set ack timer before calling listener
                stateChangeListener.ackTimer = this.setTimeout(
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore
                    async (id: string, stateChangeListener: StateChangeListenEntry) => {
                        this.log.warn(`Timeout for ack ${id}`);
                        this.incInfoState('info.ackTimeouts', id);
                        stateChangeListener.ackTimer = undefined;
                        // Even though this is a timeout, handle any change that may have been delayed waiting for this
                        await this.handleDelayedStateChange(id, stateChangeListener);
                    },
                    stateChangeListener.opts?.ackTimeoutMs ? stateChangeListener.opts?.ackTimeoutMs : ackTimeoutMs,
                    id,
                    stateChangeListener,
                );
            }

            // Change will be handled by listener
            stateChangeListener.listener(this.currentStateValues[id], val);

            if (stateChangeListener.opts?.selfAck) {
                // Loxone is not expected to send an event to acknowledge this so just do it ourself
                this.log.debug(`Self-ack: ${id} ${val}`);
                await this.setStateAck(id, val);
            }
        }
    }

    private async handleDelayedStateChange(id: string, stateChangeListener: StateChangeListenEntry): Promise<void> {
        if (stateChangeListener.queuedVal !== null) {
            this.log.debug(`Handling delayed state: ${id} ${stateChangeListener.queuedVal}`);
            await this.handleStateChange(id, stateChangeListener, stateChangeListener.queuedVal);
            stateChangeListener.queuedVal = null;
        }
    }

    private async loadStructureFileAsync(data: StructureFile): Promise<void> {
        this.stateEventHandlers = {};
        this.foundRooms = {};
        this.foundCats = {};
        this.operatingModes = data.operatingModes;
        await this.loadGlobalStatesAsync(data.globalStates);
        await this.loadControlsAsync(data.controls);
        await this.loadEnumsAsync(data.rooms, 'enum.rooms', this.foundRooms, this.config.syncRooms);
        await this.loadEnumsAsync(data.cats, 'enum.functions', this.foundCats, this.config.syncFunctions);
        await this.loadWeatherServerAsync(data.weatherServer);

        // replay all queued events
        this.runQueue = true;
        await this.handleEventQueue();
    }

    private async loadGlobalStatesAsync(globalStates: GlobalStates): Promise<void> {
        interface GlobalStateInfo {
            type: ioBroker.CommonType;
            role: string;
            handler: (name: string, value: ioBroker.StateValue) => Promise<void>;
        }
        const globalStateInfos: Record<string, GlobalStateInfo> = {
            operatingMode: {
                type: 'number',
                role: 'value',
                handler: this.setOperatingMode.bind(this),
            },
            sunrise: {
                type: 'number',
                role: 'value.interval',
                handler: this.setStateAck.bind(this),
            },
            sunset: {
                type: 'number',
                role: 'value.interval',
                handler: this.setStateAck.bind(this),
            },
            notifications: {
                type: 'number',
                role: 'value',
                handler: this.setStateAck.bind(this),
            },
            modifications: {
                type: 'number',
                role: 'value',
                handler: this.setStateAck.bind(this),
            },
            hasInternet: {
                type: 'boolean',
                role: 'indicator',
                handler: (name, value) => this.setStateAck(name, value === 1),
            },
        };
        const defaultInfo: GlobalStateInfo = {
            type: 'string',
            role: 'text',
            handler: (name, value) => this.setStateAck(name, `${value}`),
        };

        // special case for operating mode (text)
        await this.updateObjectAsync('operatingMode-text', {
            type: 'state',
            common: {
                name: 'operatingMode: text',
                read: true,
                write: false,
                type: 'string',
                role: 'text',
            },
            native: {
                uuid: globalStates.operatingMode,
            },
        });

        for (const globalStateName in globalStates) {
            const info = globalStateInfos.hasOwnProperty(globalStateName)
                ? globalStateInfos[globalStateName]
                : defaultInfo;
            await this.updateStateObjectAsync(
                globalStateName,
                {
                    name: globalStateName,
                    read: true,
                    write: false,
                    type: info.type,
                    role: info.role,
                },
                globalStates[globalStateName],
                info.handler,
            );
        }
    }

    private async setOperatingMode(name: string, value: any): Promise<void> {
        await this.setStateAck(name, value);
        await this.setStateAck(name + '-text', this.operatingModes[value]);
    }

    private async loadControlsAsync(controls: Controls): Promise<void> {
        let hasUnsupported = false;
        for (const uuid in controls) {
            const control = controls[uuid];
            if (!control.hasOwnProperty('type')) {
                continue;
            }

            try {
                await this.loadControlAsync('device', uuid, control);
            } catch (e) {
                this.log.info(`Currently unsupported control type ${control.type}: ${e}`);
                // Error logged above

                if (!hasUnsupported) {
                    hasUnsupported = true;
                    await this.updateObjectAsync('Unsupported', {
                        type: 'device',
                        common: {
                            name: 'Unsupported',
                            role: 'info',
                        },
                        native: {},
                    });
                }

                await this.updateObjectAsync('Unsupported.' + uuid, {
                    type: 'state',
                    common: {
                        name: control.name,
                        read: true,
                        write: false,
                        type: 'string',
                        role: 'text',
                    },
                    native: { control },
                });
            }
        }
    }

    public async loadSubControlsAsync(parentUuid: string, control: Control): Promise<void> {
        if (!control.hasOwnProperty('subControls')) {
            return;
        }
        for (let uuid in control.subControls) {
            const subControl = control.subControls[uuid];
            if (!subControl.hasOwnProperty('type')) {
                continue;
            }

            try {
                if (uuid.startsWith(parentUuid + '/')) {
                    uuid = uuid.replace('/', '.');
                } else {
                    uuid = parentUuid + '.' + uuid.replace('/', '-');
                }
                subControl.name = control.name + ': ' + subControl.name;

                await this.loadControlAsync('channel', uuid, subControl);
            } catch (e) {
                this.log.info(`Currently unsupported sub-control type ${subControl.type}: ${e}`);
                // Error logged above
            }
        }
    }

    private async loadControlAsync(controlType: ControlType, uuid: string, control: Control): Promise<void> {
        const type = control.type || 'None';
        if (type.match(/[^a-z0-9]/i)) {
            throw new Error(`Bad control type: ${type}`);
        }

        let controlObject: ControlBase;
        try {
            const module = await import(`./controls/${type}`);
            controlObject = new module[type](this);
        } catch (error) {
            controlObject = new Unknown(this);
        }
        await controlObject.loadAsync(controlType, uuid, control);

        if (control.hasOwnProperty('room')) {
            if (!this.foundRooms.hasOwnProperty(control.room)) {
                this.foundRooms[control.room as string] = [];
            }

            this.foundRooms[control.room].push(uuid);
        }

        if (control.hasOwnProperty('cat')) {
            if (!this.foundCats.hasOwnProperty(control.cat)) {
                this.foundCats[control.cat] = [];
            }

            this.foundCats[control.cat].push(uuid);
        }
    }

    private async loadEnumsAsync(
        values: Record<string, any>,
        enumName: string,
        found: Record<string, string[]>,
        enabled: boolean,
    ): Promise<void> {
        if (!enabled) {
            return;
        }

        for (const uuid in values) {
            if (!found.hasOwnProperty(uuid)) {
                // don't sync room/cat if we have no control that is using it
                continue;
            }

            const members = [];
            for (const i in found[uuid]) {
                members.push(this.namespace + '.' + found[uuid][i]);
            }

            const item = values[uuid];
            const name = item.name.replace(/[\][*.,;'"`<>\\?]+/g, '_');
            const obj = {
                type: 'enum',
                common: {
                    name: name,
                    members: members,
                },
                native: item,
            };

            await this.updateEnumObjectAsync(enumName + '.' + name, obj);
        }
    }

    private async updateEnumObjectAsync(id: string, newObj: any): Promise<void> {
        // TODO: the parameter newObj should be an EnumObject, but currently that doesn't exist in the type definition
        // similar to hm-rega.js:
        let obj: any = await this.getForeignObjectAsync(id);
        let changed = false;
        if (!obj) {
            obj = newObj;
            changed = true;
        } else if (newObj && newObj.common && newObj.common.members) {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            for (let m = 0; m < newObj.common.members.length; m++) {
                if (obj.common.members.indexOf(newObj.common.members[m]) === -1) {
                    changed = true;
                    obj.common.members.push(newObj.common.members[m]);
                }
            }
        }
        if (changed) {
            await this.setForeignObjectAsync(id, obj);
        }
    }

    private async loadWeatherServerAsync(data: WeatherServer): Promise<void> {
        if (this.config.weatherServer === 'off') {
            this.log.debug('WeatherServer is disabled in the adapter configuration');
            return;
        }
        const handler = new WeatherServerHandler(this);
        await handler.loadAsync(data, this.config.weatherServer || 'all');
    }

    private async handleEventQueue(): Promise<void> {
        // TODO: This solution with globals for runQueue & queueRunning
        // isn't very elegant. It works, but is there a better way?
        if (!this.runQueue) {
            this.log.silly('Asked to handle the queue, but is stopped');
        } else if (this.queueRunning) {
            this.log.silly('Asked to handle the queue, but already in progress');
        } else {
            this.queueRunning = true;
            this.log.silly('Processing events from queue length: ' + this.eventsQueue.size());
            let evt: LoxoneEvent | null;
            while ((evt = this.eventsQueue.dequeue())) {
                this.log.silly(`Dequeued event UUID: ${evt.uuid}`);
                await this.handleEvent(evt);
            }
            this.queueRunning = false;
            this.log.silly('Done with event queue');
        }
    }

    private async handleEvent(evt: LoxoneEvent): Promise<void> {
        const stateEventHandlerList = this.stateEventHandlers[evt.uuid];
        if (stateEventHandlerList === undefined) {
            this.log.debug(`Unknown event ${evt.uuid}: ${JSON.stringify(evt.evt)}`);
            this.incInfoState('info.unknownEvents', evt.uuid, evt.evt);
            return;
        }

        for (const item of stateEventHandlerList) {
            try {
                await item.handler(evt.evt);
            } catch (e) {
                this.log.error(`Error while handling event UUID ${evt.uuid}: ${e}`);
                // Error logged above
            }
        }
    }

    private async initInfoStates(): Promise<void> {
        // Wait for states to load because if we don't, although the chances
        // of processing starting before this actually completes is small, we
        // should cater for that.
        await this.initInfoState('info.ackTimeouts', true);
        await this.initInfoState('info.messagesReceived');
        await this.initInfoState('info.messagesSent');
        await this.initInfoState('info.stateChangesDelayed');
        await this.initInfoState('info.stateChangesDiscarded');
        await this.initInfoState('info.unknownEvents', true);
    }

    private async initInfoState(id: string, hasDetails = false): Promise<void> {
        const state = await this.getStateAsync(id);
        const initValue = state ? state.val : null;
        const entry: InfoEntry = {
            value: initValue,
            lastSet: initValue,
            timer: undefined,
        };

        if (hasDetails) {
            // TODO: Maybe read these in so they persist across restarts?
            entry.detailsMap = new Map<string, infoDetailsEntry>();
        }

        this.info.set(id, entry);
    }

    private flushInfoStates(): void {
        // Called on shutdown
        this.info.forEach((infoEntry, key) => {
            if (infoEntry.timer) {
                // Timer running, so cancel it and update state value if changed since last written
                this.clearTimeout(infoEntry.timer);
                this.setInfoStateIfChanged(key, infoEntry, true);
            }
        });
    }

    private getInfoEntry(id: string): InfoEntry | undefined {
        const infoEntry = this.info.get(id);
        if (!infoEntry) {
            // This should never happen!
            this.log.error('No info entry for ' + id);
        }
        return infoEntry;
    }

    private addInfoDetailsEntry(details: infoDetailsEntryMap, id: string, value?: any): void {
        /// ... and add details of this event to the map.
        const eventEntry = details.get(id);
        if (eventEntry) {
            // Add to existing
            eventEntry.count++;
            if (value !== undefined) {
                eventEntry.lastValue = value;
            }
        } else {
            // New entry
            if (value !== undefined) {
                details.set(id, { count: 1, lastValue: value });
            } else {
                details.set(id, { count: 1 });
            }
        }
    }

    private incInfoState(id: string, detailId?: string, detailValue?: any): void {
        // Increment the given ID
        const infoEntry = this.getInfoEntry(id);
        if (infoEntry) {
            // Can't use ++ here because ioBroker.StateValue isn't necessarily a number
            infoEntry.value = Number(infoEntry.value) + 1;
            // If value given and this entry has details record that
            if (infoEntry.detailsMap && detailId) {
                this.addInfoDetailsEntry(infoEntry.detailsMap, detailId, detailValue);
            }
            if (!infoEntry.timer) {
                this.setInfoStateIfChanged(id, infoEntry);
            }
        }
    }

    private buildInfoDetails(src: infoDetailsEntryMap): string {
        // TODO: shouldn't this use JSON.stringify?
        const out: any[] = [];
        src.forEach((value, key) => {
            if (value.lastValue !== undefined) {
                out.push({ id: key, count: value.count, lastValue: value.lastValue });
            } else {
                out.push({ id: key, count: value.count });
            }
        });
        return JSON.stringify(out);
    }

    private setInfoStateIfChanged(id: string, infoEntry: InfoEntry, shutdown = false): void {
        if (infoEntry.value != infoEntry.lastSet) {
            this.log.silly('value of ' + id + ' changed to ' + infoEntry.value);

            // Store counter
            void this.setState(id, infoEntry.value, true);
            infoEntry.lastSet = infoEntry.value;

            // Store any details
            if (infoEntry.detailsMap) {
                void this.setState(id + 'Detail', this.buildInfoDetails(infoEntry.detailsMap), true);
            }

            if (!shutdown) {
                // Start a timer which will set the current value from the info ID map on completion
                // Obviously don't do this if called from shutdown
                this.log.silly('Starting timer for ' + id);
                infoEntry.timer = this.setTimeout(
                    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                    // @ts-ignore
                    (cbId: string, cbInfoEntry: InfoEntry) => {
                        this.log.silly('Timeout for ' + id);

                        // Remove from timer from map as we have just finished
                        cbInfoEntry.timer = undefined;

                        // Update the state, but only if the value in the info ID map has changed
                        this.setInfoStateIfChanged(cbId, cbInfoEntry);
                    },
                    30000, // Update every 30s max TODO: make this a config parameter?
                    id,
                    infoEntry, // Pass reference to entry
                );
            }
        }
    }

    public sendCommand(uuid: string, action: string): void {
        this.log.debug(`Sending command ${uuid} ${action}`);
        this.incInfoState('info.messagesSent');
        this.socket.send(`jdev/sps/io/${uuid}/${action}`, 2);
    }

    public getExistingObject(id: string): ioBroker.Object | undefined {
        const fullId = this.namespace + '.' + id;
        if (this.existingObjects.hasOwnProperty(fullId)) {
            return this.existingObjects[fullId];
        }
        return undefined;
    }

    public async updateObjectAsync(id: string, obj: ioBroker.SettableObject): Promise<void> {
        const fullId = this.namespace + '.' + id;
        if (this.existingObjects.hasOwnProperty(fullId)) {
            const existingObject = this.existingObjects[fullId];
            if (!this.config.syncNames && obj.common) {
                obj.common.name = existingObject.common.name;
            }
            /* TODO: re-add:
            if (obj.common.smartName != 'ignore' && existingObject.common.smartName != 'ignore') {
                // keep the smartName (if it's not supposed to be ignored)
                obj.common.smartName = existingObject.common.smartName;
            }*/
        }

        await this.extendObjectAsync(id, obj);
    }

    public async updateStateObjectAsync(
        id: string,
        commonInfo: ioBroker.StateCommon,
        stateUuid: string,
        stateEventHandler?: NamedStateEventHandler,
    ): Promise<void> {
        /* TODO: re-add:
        if (commonInfo.hasOwnProperty('smartIgnore')) {
            // interpret smartIgnore (our own extension of common) to generate smartName if needed
            if (commonInfo.smartIgnore) {
                commonInfo.smartName = 'ignore';
            } else if (!commonInfo.hasOwnProperty('smartName')) {
                commonInfo.smartName = null;
            }
            delete commonInfo.smartIgnore;
        }*/
        const obj: ioBroker.SettableObjectWorker<ioBroker.StateObject> = {
            type: 'state',
            common: commonInfo,
            native: {
                uuid: stateUuid,
            },
        };
        await this.updateObjectAsync(id, obj);
        if (stateEventHandler) {
            this.addStateEventHandler(stateUuid, async (value: ioBroker.StateValue) => {
                await stateEventHandler(id, value);
            });
        }
    }

    public addStateEventHandler(uuid: string, eventHandler: StateEventHandler, name?: string): void {
        if (this.stateEventHandlers[uuid] === undefined) {
            this.stateEventHandlers[uuid] = [];
        }

        if (name) {
            this.removeStateEventHandler(uuid, name);
        }

        this.stateEventHandlers[uuid].push({ name: name, handler: eventHandler });
    }

    public removeStateEventHandler(uuid: string, name: string): boolean {
        if (this.stateEventHandlers[uuid] === undefined || !name) {
            return false;
        }

        let found = false;
        for (let i = 0; i < this.stateEventHandlers[uuid].length; i++) {
            if (this.stateEventHandlers[uuid][i].name === name) {
                this.stateEventHandlers[uuid].splice(i, 1);
                found = true;
            }
        }

        return found;
    }

    public addStateChangeListener(id: string, listener: StateChangeListener, opts?: StateChangeListenerOpts): void {
        this.stateChangeListeners[this.namespace + '.' + id] = {
            listener,
            opts,
            queuedVal: null,
            ackTimer: undefined,
        };
    }

    private async checkStateForAck(id: string): Promise<void> {
        const stateChangeListener = this.stateChangeListeners[id];
        if (stateChangeListener) {
            // This state change could be a result of a command we sent being ack'd
            if (stateChangeListener.ackTimer) {
                // Timer is running so clear it
                this.log.debug(`Clearing ackTimer for ${id}`);
                this.clearTimeout(stateChangeListener.ackTimer);
                stateChangeListener.ackTimer = undefined;
                // Send any command that may have been delayed waiting for this ack
                await this.handleDelayedStateChange(id, stateChangeListener);
            } else {
                this.log.debug(`No ackTimer for ${id}`);
            }
        } else {
            this.log.silly(`${id} has no stateChangeListener`);
        }
    }

    public async setStateAck(id: string, value: CurrentStateValue): Promise<void> {
        const keyId = this.namespace + '.' + id;
        this.currentStateValues[keyId] = value;
        await this.checkStateForAck(keyId);
        await this.setStateAsync(id, { val: value, ack: true });
    }

    public getCachedStateValue(id: string): OldStateValue {
        const keyId = this.namespace + '.' + id;
        if (this.currentStateValues.hasOwnProperty(keyId)) {
            return this.currentStateValues[keyId];
        }

        return undefined;
    }

    public reportError(message: string): void {
        this.log.error(message);
        // Error logged above
    }
}

if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Loxone(options);
} else {
    // otherwise start the instance directly
    (() => new Loxone())();
}
