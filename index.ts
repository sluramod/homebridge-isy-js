/*
 ISY-JS
 
 See README.md for details.
*/

import {
    ELKAlarmPanelDevice,
    ISY,
    ISYDoorWindowDevice,
    ISYFanDevice,
    ISYFanDeviceState,
    ISYLightDevice,
    ISYLockDevice,
    ISYMotionSensorDevice,
    ISYNode,
    ISYOutletDevice
} from "isy-js";

import {
    Accessory,
    Characteristic as HapCharacteristic,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    Service as HapService,
    uuid
} from 'hap-nodejs'
import {
    ContactSensor,
    Fan,
    GarageDoorOpener,
    Lightbulb,
    LockMechanism,
    MotionSensor,
    Outlet,
    SecuritySystem
} from "hap-nodejs/dist/lib/gen/HomeKit";
import {ISYScene} from "isy-js/lib/isyscene";
import {
    ELKAlarmPanelDeviceAlarmMode,
    ELKAlarmPanelDeviceAlarmState,
    ELKAlarmPanelDeviceAlarmTripState
} from "isy-js/lib/elkdevice";

// Global device map. Needed to map incoming notifications to the corresponding HomeKit device for update.
let deviceMap: { [idx: string]: ISYAccessoryBaseSetup<ISYNode> } = {};

// This function responds to changes in devices from the isy-js library. Uses the global device map to update
// the state.
// TODO: Move this to a member function of the ISYPlatform object so we don't need a global map.
function ISYChangeHandler(isy: any, device: ISYNode) {
    let deviceToUpdate = deviceMap[device.address];
    if (deviceToUpdate != null) {
        deviceToUpdate.handleExternalChange();
    }
}

let Service: typeof HapService, Characteristic: typeof HapCharacteristic, UUIDGen: typeof uuid,
    PlatformAccessory: typeof Accessory

interface HomeBridgePlatform {
    // Function invoked when homebridge tries to restore cached accessory.
    // Developer can configure accessory at here (like setup event handler).
    // Update current value.
    configureAccessory(accessory: Accessory): void
}

interface HomeBridgeAPI {
    on(event: string, callback: () => void): void

    registerPlatformAccessories(plugin: string, platform: string, accessories: Accessory[]): void

    unregisterPlatformAccessories(plugin: string, platform: string, accessories: Accessory[]): void
}

const pluginName = "homebridge-isy-js"
const platformName = "isy-js"

export default function (homebridge: any) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;
    PlatformAccessory = homebridge.platformAccessory

    homebridge.registerPlatform(pluginName, platformName, ISYPlatform, true);
}


////////////////////////////////////////////////////////////////////////////////////////////////
// PLATFORM

// Construct the ISY platform. log = Logger, config = homebridge cofnig

interface IgnoreDeviceRuleConfig {
    nameContains?: string
    lastAddressDigit?: string
    address?: string
}

interface RenameDeviceRuleConfig extends IgnoreDeviceRuleConfig {
    newName?: string
}

interface GarageDoorConfig {
    address: string
    name: string
    timeToOpen: number
    alternate?: boolean
}

interface ISYPlatformConfig {
    host: string
    useHttps: boolean
    username: string
    password: string
    elkEnabled?: boolean
    debugLoggingEnabled?: boolean
    includeAllScenes?: boolean
    includedScenes?: string[]
    ignoreDevices?: IgnoreDeviceRuleConfig[]
    renameDevices?: RenameDeviceRuleConfig[]
    garageDoors?: GarageDoorConfig[]
}

class ISYPlatform implements HomeBridgePlatform {
    log: Function
    api: HomeBridgeAPI
    isy: ISY

    config: ISYPlatformConfig
    host: string
    username: string
    password: string
    elkEnabled: boolean
    debugLoggingEnabled: boolean
    includeAllScenes: boolean
    includedScenes: string[]

    discoveredAccessories: Map<string, ISYAccessoryBaseSetup<ISYNode>> | null
    pendingAccessories: Set<Accessory>

    constructor(log: Function, config: ISYPlatformConfig, api: HomeBridgeAPI) {
        this.log = log;
        this.config = config;
        this.host = config.host;
        this.username = config.username;
        this.password = config.password;
        this.elkEnabled = config.elkEnabled || false
        this.debugLoggingEnabled = config.debugLoggingEnabled || false
        this.includeAllScenes = config.includeAllScenes || false
        this.includedScenes = config.includedScenes || []
        this.isy = new ISY(this.host, this.username, this.password, config.elkEnabled || false, ISYChangeHandler, config.useHttps, true, this.debugLoggingEnabled);

        this.discoveredAccessories = null
        this.pendingAccessories = new Set()
        if (api) {
            this.api = api
            this.api.on('didFinishLaunching', () => {
                this.initISYAccessories((accessories => {
                    this.discoveredAccessories = accessories.reduce((map, newValue) => {
                        map.set(newValue.device.address, newValue)
                        return map
                    }, new Map())
                    const pendingAccessories = this.pendingAccessories
                    this.pendingAccessories = new Set()
                    // remove accessories that were cached by homebridge, but
                    // they weren't discovered by ISY
                    let todoAccessories: Accessory[] = []
                    this.log(`configuring ${pendingAccessories.size} accessories`)
                    for (let pendingAccessory of pendingAccessories) {
                        const isyAccessory = this.configureCachedAccessory(pendingAccessory)
                        if (isyAccessory) {
                            this.discoveredAccessories.delete(isyAccessory.device.address)
                        } else {
                            todoAccessories.push(pendingAccessory)
                        }
                    }
                    this.log(`unregistering ${todoAccessories.length} accessories`)
                    this.api.unregisterPlatformAccessories(pluginName, platformName, todoAccessories)
                    todoAccessories = []
                    // register newly discovered accessories
                    this.discoveredAccessories.forEach(value => {
                        const accessory = value.newAccessory()
                        value.adoptAccessory(accessory)
                        todoAccessories.push(accessory)
                    })
                    this.log(`registering ${todoAccessories.length} new accessories`)
                    this.api.registerPlatformAccessories(pluginName, platformName, todoAccessories)
                }))
            })
        }
    }

    configureAccessory(accessory: Accessory): void {
        if (!this.discoveredAccessories) {
            this.pendingAccessories.add(accessory)
        } else {
            this.configureCachedAccessory(accessory)
        }
    }

    configureCachedAccessory(accessory: Accessory): ISYAccessoryBaseSetup<ISYNode> | undefined {
        function extractCachedAccessorySerialNumber(accessory: Accessory) {
            const accessoryInformationService = accessory.getService(Service.AccessoryInformation)
            return accessoryInformationService!.getCharacteristic(Characteristic.SerialNumber)!.value
        }

        const accessorySerialNumber = extractCachedAccessorySerialNumber(accessory)

        const isyAccessory = this.discoveredAccessories!.get(accessorySerialNumber as string);
        if (isyAccessory) {
            isyAccessory.adoptAccessory(accessory)
        }
        return isyAccessory
    }


    logger = (msg: any) => {
        if (this.debugLoggingEnabled || (process.env.ISYJSDEBUG != undefined && process.env.IYJSDEBUG != null)) {
            let timeStamp = new Date();
            this.log(timeStamp.getFullYear() + "-" + timeStamp.getMonth() + "-" + timeStamp.getDay() + "#" + timeStamp.getHours() + ":" + timeStamp.getMinutes() + ":" + timeStamp.getSeconds() + "- " + msg);
        }
    }

    ruleMatches(rule: IgnoreDeviceRuleConfig, device: ISYNode) {
        if (rule.nameContains != undefined && rule.nameContains != "") {
            const deviceName = device.name
            if (deviceName.indexOf(rule.nameContains) == -1) {
                return false
            }
        }
        const deviceAddress = device.address
        if (rule.lastAddressDigit != undefined && rule.lastAddressDigit != "") {
            if (deviceAddress.indexOf(rule.lastAddressDigit, deviceAddress.length - 2) == -1) {
                return false;
            }
        }
        if (rule.address != undefined && rule.address != "") {
            if (deviceAddress != rule.address) {
                return false;
            }
        }
        return true
    }

    // Checks the device against the configuration to see if it should be ignored.
    shouldIgnore(device: ISYNode) {
        let deviceAddress = device.address;
        if (device.deviceType === "scene") {
            if (this.includeAllScenes) {
                return false;
            } else {
                for (let index = 0; index < this.includedScenes.length; index++) {
                    if (this.includedScenes[index] == deviceAddress) {
                        return false;
                    }
                }
                return true;
            }
        } else {
            if (!this.config.ignoreDevices) {
                return false;
            }
            let deviceName = device.name;
            for (let index = 0; index < this.config.ignoreDevices.length; index++) {
                let rule = this.config.ignoreDevices[index];
                if (this.ruleMatches(rule, device)) {
                    this.logger("ISYPLATFORM: Ignoring device: " + deviceName + " [" + deviceAddress + "] because of rule [" + rule.nameContains + "] [" + rule.lastAddressDigit + "] [" + rule.address + "]");
                    return true;
                }
            }
        }
        return false;
    }

    getGarageEntry(address: string) {
        let garageDoorList = this.config.garageDoors;
        if (garageDoorList != undefined) {
            for (let index = 0; index < garageDoorList.length; index++) {
                let garageEntry = garageDoorList[index];
                if (garageEntry.address == address) {
                    return garageEntry;
                }
            }
        }
        return null;
    }

    renameDeviceIfNeeded(device: ISYNode) {
        let deviceAddress = device.address;
        let deviceName = device.name;
        if (this.config.renameDevices == undefined) {
            return deviceName;
        }
        for (let index = 0; index < this.config.renameDevices.length; index++) {
            let rule = this.config.renameDevices[index];
            if (this.ruleMatches(rule, device)) {
                if (!rule.newName) {
                    this.logger("ISYPLATFORM: Rule to rename device is present but no new name specified. Impacting device: " + deviceName);
                    return deviceName;
                } else {
                    this.logger("ISYPLATFORM: Renaming device: " + deviceName + "[" + deviceAddress + "] to [" + rule.newName + "] because of rule [" + rule.nameContains + "] [" + rule.lastAddressDigit + "] [" + rule.address + "]");
                    return rule.newName;
                }
            }
        }
        return deviceName;
    }

    // Calls the isy-js library, retrieves the list of devices, and maps them to appropriate ISYXXXXAccessory devices.
    initISYAccessories(callback: (accessories: ISYAccessoryBaseSetup<ISYNode>[]) => void) {
        this.isy.initialize(() => {
            let results: ISYAccessoryBaseSetup<ISYNode>[] = [];
            let deviceList = this.isy.getDeviceList();
            for (let index = 0; index < deviceList.length; index++) {
                let device = deviceList[index];
                let homeKitDevice = null;
                let garageInfo = this.getGarageEntry(device.address);
                if (!this.shouldIgnore(device)) {
                    if (results.length >= 100) {
                        this.logger("ISYPLATFORM: Skipping any further devices as 100 limit has been reached");
                        break;
                    }
                    device.name = this.renameDeviceIfNeeded(device);
                    if (garageInfo != null) {
                        let relayAddress = device.address.substr(0, device.address.length - 1);
                        relayAddress += '2';
                        let relayDevice = this.isy.getDevice(relayAddress);
                        homeKitDevice = new ISYGarageDoorAccessory(this.logger, device as ISYDoorWindowDevice, relayDevice as ISYLightDevice, garageInfo.name, garageInfo.timeToOpen, garageInfo.alternate);
                    } else if (device.deviceType == "light" || device.deviceType == "dimmableLight") {
                        homeKitDevice = new ISYLightAccessory(this.logger, device as ISYLightDevice);
                    } else if (device.deviceType == "lock" || device.deviceType == "secureLock") {
                        homeKitDevice = new ISYLockAccessory(this.logger, device as ISYLockDevice);
                    } else if (device.deviceType == "outlet") {
                        homeKitDevice = new ISYOutletAccessory(this.logger, device as ISYOutletDevice);
                    } else if (device.deviceType == "fan") {
                        homeKitDevice = new ISYFanAccessory(this.logger, device as ISYFanDevice);
                    } else if (device.deviceType == "doorWindowSensor") {
                        homeKitDevice = new ISYDoorWindowSensorAccessory(this.logger, device as ISYDoorWindowDevice);
                    } else if (device.deviceType == "alarmDoorWindowSensor") {
                        homeKitDevice = new ISYDoorWindowSensorAccessory(this.logger, device as ISYDoorWindowDevice);
                    } else if (device.deviceType == "alarmPanel") {
                        homeKitDevice = new ISYElkAlarmPanelAccessory(this.logger, device as ELKAlarmPanelDevice);
                    } else if (device.deviceType == "motionSensor") {
                        homeKitDevice = new ISYMotionSensorAccessory(this.logger, device as ISYMotionSensorDevice);
                    } else if (device.deviceType == "scene") {
                        homeKitDevice = new ISYSceneAccessory(this.logger, device as ISYScene);
                    }
                    if (homeKitDevice != null) {
                        // Make sure the device is address to the global map
                        deviceMap[device.address] = homeKitDevice;
                        results.push(homeKitDevice);
                    }
                }
            }
            if (this.isy.elkEnabled) {
                if (results.length >= 100) {
                    this.logger("ISYPLATFORM: Skipping adding Elk Alarm panel as device count already at maximum");
                } else {
                    let panelDevice = this.isy.getElkAlarmPanel();
                    if (panelDevice) {
                        panelDevice.name = this.renameDeviceIfNeeded(panelDevice);
                        let panelDeviceHK = new ISYElkAlarmPanelAccessory(this.logger, panelDevice);
                        deviceMap[panelDevice.address] = panelDeviceHK;
                        results.push(panelDeviceHK);
                    }
                }
            }
            this.logger("ISYPLATFORM: Filtered device has: " + results.length + " devices");
            callback(results);
        });
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// BASE FOR ALL DEVICES
abstract class ISYAccessoryBaseSetup<T extends ISYNode> {
    uuid: string
    log: Function
    device: T
    address: string

    updates: (() => void)[] = []

    // Provides common constructor tasks
    protected constructor(log: Function, device: T) {
        this.uuid = UUIDGen.generate(device.isy.isyAddress + ':' + device.address + 1);
        this.log = log;
        this.device = device;
    }

    scheduleCharacteristicUpdate(characteristicSetCallback: CharacteristicSetCallback, update: (callback: CharacteristicSetCallback) => void) {
        const fun = () => {
            update(characteristicSetCallback)
            this.processUpdates()
        }

        if (this.updates.push(fun) == 1) {
            this.processUpdates()
        }
    }

    processUpdates() {
        setImmediate(() => {
            this.processNextUpdate()
        })
    }

    processNextUpdate() {
        const update = this.updates.shift()
        if (update) {
            update()
        }
    }

    newAccessory(): Accessory {
        return new PlatformAccessory(this.device.name, this.uuid)
    }

    abstract identify(callback: Function): void

    abstract handleExternalChange(): void;

    abstract adoptAccessory(accessory: Accessory): void
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// FANS - ISYFanAccessory 
// Implemetnts the fan service for an isy fan device. 

// Constructs a fan accessory object. device is the isy-js device object and log is the logger. 
class ISYFanAccessory extends ISYAccessoryBaseSetup<ISYFanDevice> {

    fanService?: Fan

    constructor(log: Function, device: ISYFanDevice) {
        super(log, device)
    }

    identify(callback: Function) {
        // Do the identify action
        callback();
    }

    // Translates the fan speed as an isy-js string into the corresponding homekit constant level.
    // Homekit doesn't have steps for the fan speed and needs to have a value from 0 to 100. We
    // split the range into 4 steps and map them to the 4 isy-js levels.
    translateFanSpeedToHK(fanSpeed: ISYFanDeviceState) {
        if (fanSpeed == ISYFanDeviceState.OFF) {
            return 0;
        } else if (fanSpeed == ISYFanDeviceState.LOW) {
            return 32;
        } else if (fanSpeed == ISYFanDeviceState.MEDIUM) {
            return 67;
        } else if (fanSpeed == ISYFanDeviceState.HIGH) {
            return 100;
        } else {
            this.log("FAN: " + this.device.name + " !!!! ERROR: Unknown fan speed: " + fanSpeed);
            return 0;
        }
    }

    // Translates the fan level from homebridge into the isy-js level. Maps from the 0-100
    // to the four isy-js fan speed levels.
    translateHKToFanSpeed(fanStateHK: number) {
        if (fanStateHK == 0) {
            return ISYFanDeviceState.OFF;
        } else if (fanStateHK > 0 && fanStateHK <= 32) {
            return ISYFanDeviceState.LOW;
        } else if (fanStateHK >= 33 && fanStateHK <= 67) {
            return ISYFanDeviceState.MEDIUM;
        } else if (fanStateHK > 67) {
            return ISYFanDeviceState.HIGH;
        } else {
            this.log("FAN: " + this.device.name + " ERROR: Unknown fan state!");
            return ISYFanDeviceState.OFF;
        }
    }

    // Returns the current state of the fan from the isy-js level to the 0-100 level of HK.
    getFanRotationSpeed(callback: CharacteristicGetCallback) {
        this.log("FAN: " + this.device.name + " Getting fan rotation speed. Device says: " + this.device.getCurrentFanState() + " translation says: " + this.translateFanSpeedToHK(this.device.getCurrentFanState()))
        callback(null, this.translateFanSpeedToHK(this.device.getCurrentFanState()));
    }

    // Sets the current state of the fan from the 0-100 level of HK to the isy-js level.
    setFanRotationSpeed(fanStateHK: number, callback: CharacteristicSetCallback) {
        this.log(`FAN: ${this.device.name} setFanRotationSpeed(fanStateHK)`);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            let newFanState = this.translateHKToFanSpeed(fanStateHK);
            this.log("FAN: " + this.device.name + " Sending command to set fan state to: " + newFanState);
            this.device.sendFanCommand(newFanState, () => {
                doneCallback();
            });
        })
    }

    // Returns true if the fan is on
    getIsFanOn() {
        let value = this.device.getCurrentFanState() != ISYFanDeviceState.OFF;
        this.log("FAN: " + this.device.name + " Getting fan is on. Device says: " + this.device.getCurrentFanState() + " Code says: " + value);
        return value;
    }

    // Returns the state of the fan to the homebridge system for the On characteristic
    getFanOnState(callback: CharacteristicGetCallback) {
        callback(null, this.getIsFanOn());
    }

    // Sets the fan state based on the value of the On characteristic. Default to Medium for on.
    setFanOnState(onState: boolean, callback: CharacteristicSetCallback) {
        this.log(`FAN: ${this.device.name} setFanOnState(${onState})`);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            this.log("FAN: " + this.device.name + " Setting fan on state to: " + onState + " Device says: " + this.device.getCurrentFanState());
            if (onState) {
                this.log("FAN: " + this.device.name + " Setting fan speed to medium");
                this.setFanRotationSpeed(this.translateFanSpeedToHK(ISYFanDeviceState.MEDIUM), doneCallback);
            } else {
                this.log("FAN: " + this.device.name + " Setting fan speed to off");
                this.setFanRotationSpeed(this.translateFanSpeedToHK(ISYFanDeviceState.OFF), doneCallback);
            }
        })
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        if (this.device.updateRequested) {
            this.log("FAN: " + this.device.name + " Ignoring external change");
            return
        }
        this.log("FAN: " + this.device.name + " Incoming external change. Device says: " + this.device.getCurrentFanState());
        const fanService = this.fanService
        if (fanService) {
            fanService
                .setCharacteristic(Characteristic.On, this.getIsFanOn());

            fanService
                .setCharacteristic(Characteristic.RotationSpeed, this.translateFanSpeedToHK(this.device.getCurrentFanState()));
        }
    }

    newAccessory(): Accessory {
        const newAccessory = super.newAccessory()
        newAccessory.addService(Service.Fan);
        return newAccessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let fanService = accessory.getService(Service.Fan);
        this.fanService = fanService;

        fanService!
            .getCharacteristic(Characteristic.On)!
            .on(CharacteristicEventTypes.SET, this.setFanOnState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getFanOnState.bind(this));

        fanService!
            .getCharacteristic(Characteristic.RotationSpeed)!
            .on(CharacteristicEventTypes.GET, this.getFanRotationSpeed.bind(this))
            .on(CharacteristicEventTypes.SET, this.setFanRotationSpeed.bind(this));
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// OUTLETS - ISYOutletAccessory
// Implements the Outlet service for ISY devices.

// Constructs an outlet. log = HomeBridge logger, device = isy-js device to wrap
class ISYOutletAccessory extends ISYAccessoryBaseSetup<ISYOutletDevice> {
    outletService?: Outlet

    constructor(log: Function, device: ISYOutletDevice) {
        super(log, device);
    }


    // Handles the identify command
    identify(callback: Function) {
        // Do the identify action
        callback();
    }

    // Handles a request to set the outlet state. Ignores redundant sets based on current states.
    setOutletState(outletState: boolean, callback: CharacteristicSetCallback) {
        this.log(`OUTLET: ${this.device.name} setOutletState(${outletState})`);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            this.device.sendOutletCommand(outletState, () => {
                doneCallback();
            });
        });

    }

    // Handles a request to get the current outlet state based on underlying isy-js device object.
    getOutletState(callback: CharacteristicGetCallback) {
        callback(null, this.device.getCurrentOutletState());
    }

    // Handles a request to get the current in use state of the outlet. We set this to true always as
    // there is no way to deterine this through the isy.
    getOutletInUseState(callback: CharacteristicGetCallback) {
        callback(null, true);
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        if (this.device.updateRequested) {
            this.log("OUTLET: " + this.device.name + " Ignoring external change");
            return
        }
        this.outletService!
            .setCharacteristic(Characteristic.On, this.device.getCurrentOutletState());
    }

    newAccessory(): Accessory {
        const newAccessory = super.newAccessory()
        newAccessory.addService(Service.Outlet);
        return newAccessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.FirmwareRevision, this.device.isyType)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let outletService = accessory.getService(Service.Outlet);
        this.outletService = outletService;

        outletService!
            .getCharacteristic(Characteristic.On)!
            .on(CharacteristicEventTypes.SET, this.setOutletState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getOutletState.bind(this));

        outletService!
            .getCharacteristic(Characteristic.OutletInUse)!
            .on(CharacteristicEventTypes.GET, this.getOutletInUseState.bind(this));
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// LOCKS - ISYLockAccessory
// Implements the lock service for isy-js devices. 

// Constructs a lock accessory. log = homebridge logger, device = isy-js device object being wrapped
class ISYLockAccessory extends ISYAccessoryBaseSetup<ISYLockDevice> {

    lockService?: LockMechanism

    constructor(log: Function, device: ISYLockDevice) {
        super(log, device);
    }

    // Handles an identify request
    identify(callback: Function) {
        callback();
    }

    // Handles a set to the target lock state. Will ignore redundant commands.
    setTargetLockState(lockState: number, callback: CharacteristicSetCallback) {
        this.log(this, `LOCK: ${this.device.name} setTargetLockState(${lockState})`);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            let targetLockValue = lockState != 0;
            this.device.sendLockCommand(targetLockValue, () => {
                doneCallback();
            });
        })
    }

    // Translates underlying lock state into the corresponding homekit state
    getDeviceCurrentStateAsHK() {
        return (this.device.getCurrentLockState() ? 1 : 0);
    }

    // Handles request to get the current lock state for homekit
    getLockCurrentState(callback: CharacteristicGetCallback) {
        callback(null, this.getDeviceCurrentStateAsHK());
    }

    // Handles request to get the target lock state for homekit
    getTargetLockState(callback: CharacteristicGetCallback) {
        this.getLockCurrentState(callback);
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        if (this.device.updateRequested) {
            this.log("LOCK: " + this.device.name + " Ignoring external change");
            return
        }
        this.lockService!
            .setCharacteristic(Characteristic.LockTargetState, this.getDeviceCurrentStateAsHK());
        this.lockService!
            .setCharacteristic(Characteristic.LockCurrentState, this.getDeviceCurrentStateAsHK());
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.LockMechanism);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation)

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let lockMechanismService = accessory.getService(Service.LockMechanism);
        this.lockService = lockMechanismService;

        lockMechanismService!
            .getCharacteristic(Characteristic.LockTargetState)!
            .on(CharacteristicEventTypes.SET, this.setTargetLockState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getTargetLockState.bind(this));

        lockMechanismService!
            .getCharacteristic(Characteristic.LockCurrentState)!
            .on(CharacteristicEventTypes.GET, this.getLockCurrentState.bind(this));
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////
// LIGHTS
// Implements the Light service for homekit based on an underlying isy-js device. Is dimmable or not depending
// on if the underlying device is dimmable. 

// Constructs the light accessory. log = homebridge logger, device = isy-js device object being wrapped
class ISYLightAccessory extends ISYAccessoryBaseSetup<ISYLightDevice> {

    dimmable: boolean
    lightService?: Lightbulb
    pendingPowerState?: boolean

    constructor(log: Function, device: ISYLightDevice) {
        super(log, device);
        this.dimmable = this.device.deviceType == "dimmableLight";
    }

    // Handles the identify command
    identify(callback: Function) {
        callback()
    }

    // Handles request to set the current powerstate from homekit. Will ignore redundant commands.
    setPowerState(powerOn: boolean, callback: CharacteristicSetCallback) {
        this.log(`LIGHT: ${this.device.name} setPowerState(${powerOn})`);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            const currentLightState = this.device.getCurrentLightState();
            this.log("LIGHT: " + this.device.name + " Changing powerstate to " + powerOn + ", currentState=" + currentLightState);

            if (powerOn != currentLightState && powerOn !== this.pendingPowerState) {
                this.pendingPowerState = powerOn
                this.device.sendLightCommand(powerOn, () => {
                    this.pendingPowerState = undefined
                    doneCallback();
                });
            } else {
                doneCallback();
            }
        })
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        if (this.device.updateRequested) {
            this.log("LIGHT: " + this.device.name + " Ignoring external change");
            return
        }
        this.log("LIGHT: " + this.device.name + " Handling external change for light");
        this.lightService!
            .setCharacteristic(Characteristic.On, this.device.getCurrentLightState());
        if (this.dimmable) {
            this.lightService!
                .setCharacteristic(Characteristic.Brightness, this.device.getCurrentLightDimState());
        }
    }

    // Handles request to get the current on state
    getPowerState(callback: CharacteristicGetCallback) {
        callback(null, this.device.getCurrentLightState());
    }

    // Handles request to set the brightness level of dimmable lights. Ignore redundant commands.
    setBrightness(level: number, callback: CharacteristicSetCallback) {
        this.log(`LIGHT: ${this.device.name} setBrightness(${level})`);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            if (level != this.device.getCurrentLightDimState()) {
                if (level == 0) {
                    this.log("LIGHT: " + this.device.name + " Brightness set to 0, sending off command");
                    this.pendingPowerState = false
                    this.device.sendLightCommand(false, () => {
                        this.pendingPowerState = undefined
                        doneCallback();
                    });
                } else {
                    this.log("LIGHT: " + this.device.name + " Changing Brightness to " + level);
                    this.device.sendLightDimCommand(level, () => {
                        this.log("LIGHT: " + this.device.name + " Done changing brightness to " + level);
                        doneCallback();
                    });
                }
            } else {
                doneCallback()
            }
        })
    }

    // Handles a request to get the current brightness level for dimmable lights.
    getBrightness(callback: CharacteristicGetCallback) {
        callback(null, this.device.getCurrentLightDimState());
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.Lightbulb);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let lightBulbService = accessory.getService(Service.Lightbulb);
        this.lightService = lightBulbService;

        lightBulbService!
            .getCharacteristic(Characteristic.On)!
            .on(CharacteristicEventTypes.SET, this.setPowerState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getPowerState.bind(this));

        if (this.dimmable) {
            lightBulbService!
                .getCharacteristic(Characteristic.Brightness)!
                .on(CharacteristicEventTypes.GET, this.getBrightness.bind(this))
                .on(CharacteristicEventTypes.SET, this.setBrightness.bind(this));
        }
    }
}


////////////////////////////////////////////////////////////////////////////////////////////////////////
// SCENES
// Implements the Light service for homekit based on an underlying isy-js device. Is dimmable or not depending
// on if the underlying device is dimmable.

// Constructs the light accessory. log = homebridge logger, device = isy-js device object being wrapped
class ISYSceneAccessory extends ISYAccessoryBaseSetup<ISYScene> {

    lightService?: Lightbulb

    constructor(log: Function, device: ISYScene) {
        super(log, device);
    }

    // Handles the identify command
    identify(callback: Function) {
        callback()
    }

    // Handles request to set the current powerstate from homekit. Will ignore redundant commands.
    setPowerState(powerOn: boolean, callback: CharacteristicSetCallback) {
        this.log("SCENE: " + this.device.name + " Setting powerstate to " + powerOn);
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            if (!this.device.getAreAllLightsInSpecifiedState(powerOn)) {
                this.log("SCENE: " + this.device.name + " Changing powerstate to " + powerOn);
                this.device.sendLightCommand(powerOn, () => {
                    doneCallback();
                });
            } else {
                this.log("SCENE: " + this.device.name + " Ignoring redundant setPowerState");
                doneCallback();
            }
        })
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        this.log("SCENE: " + this.device.name + " Handling external change for light");
        if (this.device.getAreAllLightsInSpecifiedState(true) || this.device.getAreAllLightsInSpecifiedState(false)) {
            this.lightService!
                .setCharacteristic(Characteristic.On, this.device.getAreAllLightsInSpecifiedState(true));
        }
    }

    calculatePowerState() {
        return this.device.getAreAllLightsInSpecifiedState(true);
    }

    // Handles request to get the current on state
    getPowerState(callback: CharacteristicGetCallback) {
        callback(null, this.calculatePowerState());
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.Lightbulb);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, "Insteon Scene")
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let lightBulbService = accessory.getService(Service.Lightbulb);
        this.lightService = lightBulbService;

        lightBulbService!
            .getCharacteristic(Characteristic.On)!
            .on(CharacteristicEventTypes.SET, this.setPowerState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getPowerState.bind(this));
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// CONTACT SENSOR - ISYDoorWindowSensorAccessory
// Implements the ContactSensor service.

// Constructs a Door Window Sensor (contact sensor) accessory. log = HomeBridge logger, device = wrapped isy-js device.
class ISYDoorWindowSensorAccessory extends ISYAccessoryBaseSetup<ISYDoorWindowDevice> {
    doorWindowState: boolean
    sensorService?: ContactSensor

    constructor(log: Function, device: ISYDoorWindowDevice) {
        super(log, device);
        this.doorWindowState = false;
    }

    // Handles the identify command.
    identify(callback: Function) {
        // Do the identify action
        callback();
    }

    // Translates the state of the underlying device object into the corresponding homekit compatible state
    translateCurrentDoorWindowState() {
        return (this.device.getCurrentDoorWindowState()) ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED;
    }

    // Handles the request to get he current door window state.
    getCurrentDoorWindowState(callback: CharacteristicGetCallback) {
        callback(null, this.translateCurrentDoorWindowState());
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        this.sensorService!
            .setCharacteristic(Characteristic.ContactSensorState, this.translateCurrentDoorWindowState());
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.ContactSensor);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let sensorService = accessory.getService(Service.ContactSensor);
        this.sensorService = sensorService;

        sensorService!
            .getCharacteristic(Characteristic.ContactSensorState)!
            .on(CharacteristicEventTypes.GET, this.getCurrentDoorWindowState.bind(this));

    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// MOTION SENSOR - ISYMotionSensorAccessory
// Implements the ContactSensor service.

// Constructs a Door Window Sensor (contact sensor) accessory. log = HomeBridge logger, device = wrapped isy-js device.
class ISYMotionSensorAccessory extends ISYAccessoryBaseSetup<ISYMotionSensorDevice> {
    sensorService?: MotionSensor

    constructor(log: Function, device: ISYMotionSensorDevice) {
        super(log, device);
    }

    // Handles the identify command.
    identify(callback: Function) {
        // Do the identify action
        callback();
    }

    // Handles the request to get he current motion sensor state.
    getCurrentMotionSensorState(callback: CharacteristicGetCallback) {
        callback(null, this.device.getCurrentMotionSensorState());
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        this.sensorService!
            .setCharacteristic(Characteristic.MotionDetected, this.device.getCurrentMotionSensorState());
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.MotionSensor);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let sensorService = accessory.getService(Service.MotionSensor);
        this.sensorService = sensorService;

        sensorService!
            .getCharacteristic(Characteristic.MotionDetected)!
            .on(CharacteristicEventTypes.GET, this.getCurrentMotionSensorState.bind(this));
    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// ELK SENSOR PANEL - ISYElkAlarmPanelAccessory
// Implements the SecuritySystem service for an elk security panel connected to the isy system

// Constructs the alarm panel accessory. log = HomeBridge logger, device = underlying isy-js device being wrapped
class ISYElkAlarmPanelAccessory extends ISYAccessoryBaseSetup<ELKAlarmPanelDevice> {

    alarmPanelService?: SecuritySystem

    constructor(log: Function, device: ELKAlarmPanelDevice) {
        super(log, device);
    }

    // Handles the identify command
    identify(callback: Function) {
        callback();
    }

    // Handles the request to set the alarm target state
    setAlarmTargetState(targetStateHK: number, callback: CharacteristicSetCallback) {
        this.log(`ALARMSYSTEM: ${this.device.name} setAlarmTargetState(${targetStateHK})`)
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            this.log("ALARMSYSTEM: " + this.device.name + "Sending command to set alarm panel state to: " + targetStateHK);
            let targetState = this.translateHKToAlarmTargetState(targetStateHK);
            this.log("ALARMSYSTEM: " + this.device.name + " Would send the target state of: " + targetState);
            if (this.device.getAlarmMode() != targetState) {
                this.device.sendSetAlarmModeCommand(targetState, () => {
                    doneCallback();
                });
            } else {
                this.log("ALARMSYSTEM: " + this.device.name + " Redundant command, already in that state.");
                doneCallback();
            }
        })
    }

    // Translates from the current state of the elk alarm system into a homekit compatible state. The elk panel has a lot more
    // possible states then can be directly represented by homekit so we map them. If the alarm is going off then it is tripped.
    // If it is arming or armed it is considered armed. Stay maps to the state state, away to the away state, night to the night
    // state.
    translateAlarmCurrentStateToHK() {
        let tripState = this.device.getAlarmTripState();
        let sourceAlarmState = this.device.getAlarmState();
        let sourceAlarmMode = this.device.getAlarmMode();

        if (tripState >= ELKAlarmPanelDeviceAlarmTripState.ALARM_TRIP_STATE_TRIPPED) {
            return Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED;
        } else if (sourceAlarmState == ELKAlarmPanelDeviceAlarmState.ALARM_STATE_NOT_READY_TO_ARM ||
            sourceAlarmState == ELKAlarmPanelDeviceAlarmState.ALARM_STATE_READY_TO_ARM ||
            sourceAlarmState == ELKAlarmPanelDeviceAlarmState.ALARM_STATE_READY_TO_ARM_VIOLATION) {
            return Characteristic.SecuritySystemCurrentState.DISARMED;
        } else {
            if (sourceAlarmMode == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_STAY || sourceAlarmMode == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_STAY_INSTANT) {
                return Characteristic.SecuritySystemCurrentState.STAY_ARM;
            } else if (sourceAlarmMode == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_AWAY || sourceAlarmMode == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_VACATION) {
                return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
            } else if (sourceAlarmMode == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_NIGHT || sourceAlarmMode == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_NIGHT_INSTANT) {
                return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
            } else {
                this.log("ALARMSYSTEM: " + this.device.name + " Setting to disarmed because sourceAlarmMode is " + sourceAlarmMode);
                return Characteristic.SecuritySystemCurrentState.DISARMED;
            }
        }
    }

    // Translates the current target state of hthe underlying alarm into the appropriate homekit value
    translateAlarmTargetStateToHK() {
        let sourceAlarmState = this.device.getAlarmMode();
        if (sourceAlarmState == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_STAY || sourceAlarmState == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_STAY_INSTANT) {
            return Characteristic.SecuritySystemTargetState.STAY_ARM;
        } else if (sourceAlarmState == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_AWAY || sourceAlarmState == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_VACATION) {
            return Characteristic.SecuritySystemTargetState.AWAY_ARM;
        } else if (sourceAlarmState == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_NIGHT || sourceAlarmState == ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_NIGHT_INSTANT) {
            return Characteristic.SecuritySystemTargetState.NIGHT_ARM;
        } else {
            return Characteristic.SecuritySystemTargetState.DISARM;
        }
    }

    // Translates the homekit version of the alarm target state into the appropriate elk alarm panel state
    translateHKToAlarmTargetState(state: number) {
        if (state == Characteristic.SecuritySystemTargetState.STAY_ARM) {
            return ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_STAY;
        } else if (state == Characteristic.SecuritySystemTargetState.AWAY_ARM) {
            return ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_AWAY;
        } else if (state == Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
            return ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_NIGHT;
        } else {
            return ELKAlarmPanelDeviceAlarmMode.ALARM_MODE_DISARMED;
        }
    }

    // Handles request to get the target alarm state
    getAlarmTargetState(callback: CharacteristicGetCallback) {
        callback(null, this.translateAlarmTargetStateToHK());
    }

    // Handles request to get the current alarm state
    getAlarmCurrentState(callback: CharacteristicGetCallback) {
        callback(null, this.translateAlarmCurrentStateToHK());
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        if (this.device.updateRequested) {
            this.log("ALARMPANEL: " + this.device.name + " Ignoring external change");
            return
        }
        this.log("ALARMPANEL: " + this.device.name + " Source device. Currenty state locally -" + this.device.getAlarmStatusAsText());
        this.log("ALARMPANEL: " + this.device.name + " Got alarm change notification. Setting HK target state to: " + this.translateAlarmTargetStateToHK() + " Setting HK Current state to: " + this.translateAlarmCurrentStateToHK());
        this.alarmPanelService!
            .setCharacteristic(Characteristic.SecuritySystemTargetState, this.translateAlarmTargetStateToHK());
        this.alarmPanelService!
            .setCharacteristic(Characteristic.SecuritySystemCurrentState, this.translateAlarmCurrentStateToHK());
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.SecuritySystem);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let alarmPanelService = accessory.getService(Service.SecuritySystem);
        this.alarmPanelService = alarmPanelService;

        alarmPanelService!
            .getCharacteristic(Characteristic.SecuritySystemTargetState)!
            .on(CharacteristicEventTypes.SET, this.setAlarmTargetState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getAlarmTargetState.bind(this));

        alarmPanelService!
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)!
            .on(CharacteristicEventTypes.GET, this.getAlarmCurrentState.bind(this));

    }
}

/////////////////////////////////////////////////////////////////////////////////////////////////
// LOCKS - ISYGarageDoorAccessory
// Implements the lock service for isy-js devices.

// Constructs a lock accessory. log = homebridge logger, device = isy-js device object being wrapped
class ISYGarageDoorAccessory
    extends ISYAccessoryBaseSetup<ISYDoorWindowDevice> {
    targetGarageState: number
    currentGarageState: number
    alternate: boolean
    relayDevice: ISYLightDevice
    timeToOpen: number

    garageDoorService?: GarageDoorOpener

    constructor(log: Function, sensorDevice: ISYDoorWindowDevice, relayDevice: ISYLightDevice, name: string, timeToOpen: number, alternate ?: boolean) {
        super(log, sensorDevice);
        this.timeToOpen = timeToOpen;
        this.relayDevice = relayDevice;
        this.alternate = alternate || false;
        if (this.getSensorState()) {
            this.log("GARAGE: " + this.device.name + " Initial set during startup the sensor is open so defaulting states to open");
            this.targetGarageState = Characteristic.TargetDoorState.OPEN;
            this.currentGarageState = Characteristic.CurrentDoorState.OPEN;
        } else {
            this.log("GARAGE: " + this.device.name + " Initial set during startup the sensor is closed so defaulting states to closed");
            this.targetGarageState = Characteristic.TargetDoorState.CLOSED;
            this.currentGarageState = Characteristic.CurrentDoorState.CLOSED;
        }
    }

    // Handles an identify request
    identify(callback: Function) {
        callback();
    }

    getSensorState() {
        if (this.alternate) {
            return !this.device.getCurrentDoorWindowState();
        } else {
            return this.device.getCurrentDoorWindowState();
        }
    }

    sendGarageDoorCommand(callback: CharacteristicSetCallback) {
        this.relayDevice.sendLightCommand(true, () => {
            callback();
        });
    }

    // Handles a set to the target lock state. Will ignore redundant commands.
    setTargetDoorState(targetState: number, callback: CharacteristicSetCallback) {
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            if (targetState == this.targetGarageState) {
                this.log("GARAGE: Ignoring redundant set of target state");
                doneCallback();
                return;
            }
            this.targetGarageState = targetState;
            if (this.currentGarageState == Characteristic.CurrentDoorState.OPEN) {
                if (targetState == Characteristic.TargetDoorState.CLOSED) {
                    this.log("GARAGE: " + this.device.name + " Current state is open and target is closed. Changing state to closing and sending command");
                    const garageDoorService = this.garageDoorService
                    if (garageDoorService) {
                        garageDoorService
                            .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSING);

                        this.sendGarageDoorCommand(doneCallback);
                    }
                }
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.CLOSED) {
                if (targetState == Characteristic.TargetDoorState.OPEN) {
                    this.log("GARAGE: " + this.device.name + " Current state is closed and target is open. Waiting for sensor change to trigger opening state");
                    this.sendGarageDoorCommand(doneCallback);
                    return;
                }
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.OPENING) {
                if (targetState == Characteristic.TargetDoorState.CLOSED) {
                    this.log("GARAGE: " + this.device.name + " Current state is opening and target is closed. Sending command and changing state to closing");
                    const garageDoorService = this.garageDoorService
                    if (garageDoorService) {
                        garageDoorService
                            .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSING);

                        this.sendGarageDoorCommand(() => {
                            setTimeout(() => {
                                this.sendGarageDoorCommand(doneCallback);
                            }, 3000);
                        });
                    }
                    return;
                }
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.CLOSING) {
                if (targetState == Characteristic.TargetDoorState.OPEN) {
                    this.log("GARAGE: " + this.device.name + " Current state is closing and target is open. Sending command and setting timeout to complete");
                    const garageDoorService = this.garageDoorService
                    if (garageDoorService) {
                        garageDoorService
                            .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPENING);
                        this.sendGarageDoorCommand(() => {
                            this.sendGarageDoorCommand(doneCallback);
                            setTimeout(() => {
                                this.completeOpen()
                            }, this.timeToOpen);
                        });
                    }
                }
            }
        })
    }

    // Handles request to get the current lock state for homekit
    getCurrentDoorState(callback: CharacteristicGetCallback) {
        callback(null, this.currentGarageState);
    }

    setCurrentDoorState(newState: number, callback: CharacteristicSetCallback) {
        this.scheduleCharacteristicUpdate(callback, doneCallback => {
            this.currentGarageState = newState;
            doneCallback();
        })
    }

    // Handles request to get the target lock state for homekit
    getTargetDoorState(callback: CharacteristicGetCallback) {
        callback(null, this.targetGarageState);
    }

    completeOpen() {
        if (this.currentGarageState == Characteristic.CurrentDoorState.OPENING) {
            this.log("GARAGE:  " + this.device.name + "Current door has bee opening long enough, marking open");
            const garageDoorService = this.garageDoorService
            if (garageDoorService) {
                garageDoorService
                    .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPEN);
            }
        } else {
            this.log("GARAGE:  " + this.device.name + "Opening aborted so not setting opened state automatically");
        }
    }

    // Mirrors change in the state of the underlying isj-js device object.
    handleExternalChange() {
        if (this.device.updateRequested) {
            this.log("GARAGE: " + this.device.name + " Ignoring external change");
            return
        }
        // Handle startup.
        if (this.getSensorState()) {
            if (this.currentGarageState == Characteristic.CurrentDoorState.OPEN) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is open and now sensor matches. No action to take");
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.CLOSED) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is closed and now sensor says open. Setting state to opening");
                const garageDoorService = this.garageDoorService
                if (garageDoorService) {
                    garageDoorService
                        .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPENING);
                    this.targetGarageState = Characteristic.TargetDoorState.OPEN;
                    garageDoorService
                        .setCharacteristic(Characteristic.TargetDoorState, Characteristic.CurrentDoorState.OPEN);
                    setTimeout(this.completeOpen, this.timeToOpen);
                }
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.OPENING) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is opening and now sensor matches. No action to take");
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.CLOSING) {
                this.log("GARAGE: C " + this.device.name + "urrent state of door is closing and now sensor matches. No action to take");
            }
        } else {
            if (this.currentGarageState == Characteristic.CurrentDoorState.OPEN) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is open and now sensor shows closed. Setting current state to closed");
                const garageDoorService = this.garageDoorService
                if (garageDoorService) {
                    garageDoorService
                        .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
                    this.targetGarageState = Characteristic.TargetDoorState.CLOSED;
                    garageDoorService
                        .setCharacteristic(Characteristic.TargetDoorState, Characteristic.TargetDoorState.CLOSED);
                }
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.CLOSED) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is closed and now sensor shows closed. No action to take");
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.OPENING) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is opening and now sensor shows closed. Setting current state to closed");
                const garageDoorService = this.garageDoorService
                if (garageDoorService) {
                    garageDoorService
                        .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
                    this.targetGarageState = Characteristic.TargetDoorState.CLOSED;
                    garageDoorService
                        .setCharacteristic(Characteristic.TargetDoorState, Characteristic.TargetDoorState.CLOSED);
                }
            } else if (this.currentGarageState == Characteristic.CurrentDoorState.CLOSING) {
                this.log("GARAGE:  " + this.device.name + "Current state of door is closing and now sensor shows closed. Setting current state to closed");
                const garageDoorService = this.garageDoorService
                if (garageDoorService) {
                    garageDoorService
                        .setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
                    this.targetGarageState = Characteristic.TargetDoorState.CLOSED;
                    garageDoorService
                        .setCharacteristic(Characteristic.TargetDoorState, Characteristic.TargetDoorState.CLOSED);
                }
            }
        }
    }

    getObstructionState(callback: CharacteristicGetCallback) {
        callback(null, false);
    }

    newAccessory(): Accessory {
        let accessory = super.newAccessory();
        accessory.addService(Service.GarageDoorOpener);
        return accessory
    }

    adoptAccessory(accessory: Accessory): void {
        let informationService = accessory.getService(Service.AccessoryInformation);

        informationService!
            .setCharacteristic(Characteristic.Manufacturer, "SmartHome")
            .setCharacteristic(Characteristic.Model, this.device.deviceFriendlyName)
            .setCharacteristic(Characteristic.SerialNumber, this.device.address);

        let garageDoorService = accessory.getService(Service.GarageDoorOpener);

        this.garageDoorService = garageDoorService;

        garageDoorService!
            .getCharacteristic(Characteristic.TargetDoorState)!
            .on(CharacteristicEventTypes.SET, this.setTargetDoorState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getTargetDoorState.bind(this));

        garageDoorService!
            .getCharacteristic(Characteristic.CurrentDoorState)!
            .on(CharacteristicEventTypes.SET, this.setCurrentDoorState.bind(this))
            .on(CharacteristicEventTypes.GET, this.getCurrentDoorState.bind(this));

        garageDoorService!
            .getCharacteristic(Characteristic.ObstructionDetected)!
            .on(CharacteristicEventTypes.GET, this.getObstructionState.bind(this));
    }
}
