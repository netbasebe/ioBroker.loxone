"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Unknown = void 0;
const control_base_1 = require("./control-base");
/**
 * This class is used if the control has an unknown type.
 * It will just load the simple default states.
 */
class Unknown extends control_base_1.ControlBase {
    async loadAsync(type, uuid, control) {
        var _a;
        // report unsupported control
        const existingObject = this.adapter.getExistingObject(uuid);
        const currentVersion = this.adapter.version;
        const msg = `Unsupported ${type} control ${control.type}`;
        this.adapter.log.info(msg);
        if (((_a = existingObject === null || existingObject === void 0 ? void 0 : existingObject.native) === null || _a === void 0 ? void 0 : _a.reportedVersion) !== currentVersion) {
            // missing control wasn't reported yet for the current adapter version
            if (!this.adapter.reportedMissingControls.has(msg)) {
                this.adapter.reportedMissingControls.add(msg);
                // Unknown control type logged above
            }
        }
        await this.updateObjectAsync(uuid, {
            type: type,
            common: {
                name: `Unsupported: ${control.name}`,
                role: 'info',
            },
            native: { control, reportedVersion: currentVersion },
        });
        await this.loadOtherControlStatesAsync(control.name, uuid, control.states, []);
        await this.loadSubControlsAsync(uuid, control);
    }
}
exports.Unknown = Unknown;
//# sourceMappingURL=Unknown.js.map