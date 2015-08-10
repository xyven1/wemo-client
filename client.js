var util = require('util');
var http = require('http');
var xml2js = require('xml2js');
var EventEmitter = require('events').EventEmitter;

var WemoClient = module.exports = function(config) {
  EventEmitter.call(this);

  this.host = config.host;
  this.port = config.port;
  this.path = config.path;
  this.deviceType = config.deviceType;
  this.UDN = config.UDN;
  this.subscriptions = {};
  this.callbackURL = config.callbackURL;
  this.device = config;
  this.debug = false;

  // Create map of services
  config.serviceList.service.forEach(function(service){
    this[service.serviceType[0]] = {
      serviceId: service.serviceId[0],
      controlURL: service.controlURL[0],
      eventSubURL: service.eventSubURL[0],
    };
  }, this.services = {});

  // Transparently subscribe to serviceType events
  // TODO: Unsubscribe from ServiceType when all listeners have been removed.
  this.on('newListener', this._onListenerAdded);
};

util.inherits(WemoClient, EventEmitter);

WemoClient.EventServices = {
  insightParams: 'urn:Belkin:service:insight:1',
  statusChange: 'urn:Belkin:service:bridge:1',
  attributeList: 'urn:Belkin:service:basicevent:1',
  binaryState:  'urn:Belkin:service:basicevent:1'
};

WemoClient.prototype.soapAction = function(serviceType, action, body, cb) {
  var soapHeader = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>';
  var soapFooter = '</s:Body></s:Envelope>';

  var options = {
    host: this.host,
    port: this.port,
    path: this.services[serviceType].controlURL,
    method: 'POST',
    headers: {
      'SOAPACTION': '"' + serviceType + '#' + action + '"',
      'Content-Type': 'text/xml; charset="utf-8"'
    }
  };

  var req = http.request(options, function(res) {
    var data = '';
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      data += chunk;
    });
    res.on('end', function() {
      if (cb) {
        cb(null, data);
      }
    });
    res.on('error', function(err) {
      console.log(err);
    });
  });
  req.write(soapHeader);
  req.write(body);
  req.write(soapFooter);
  req.end();
};

WemoClient.prototype.getEndDevices = function(cb) {
  var self = this;

  // TODO: Refactor parsing and group handling
  var parseResponse = function(err, data) {
    if (err) cb(err);
    xml2js.parseString(data, function(err, result) {
      if (!err) {
        var list = result['s:Envelope']['s:Body'][0]['u:GetEndDevicesResponse'][0].DeviceLists[0];
        xml2js.parseString(list, function(err, result2) {
          if (!err) {
            var devinfo = result2.DeviceLists.DeviceList[0].DeviceInfos[0].DeviceInfo;
            if (devinfo) {
              for (var i = 0; i < devinfo.length; i++) {
                var device = {
                  friendlyName: devinfo[i].FriendlyName[0],
                  deviceId: devinfo[i].DeviceID[0],
                  currentState: devinfo[i].CurrentState[0].split(','),
                  capabilities: devinfo[i].CapabilityIDs[0].split(',')
                };
                device.internalState = {};
                for (var i = 0; i < device.capabilities.length; i++) {
                  device.internalState[device.capabilities[i]] = device.currentState[i];
                }
                cb(null, device);
              }
            }
            var groupinfos = result2.DeviceLists.DeviceList[0].GroupInfos;
            if (groupinfos) {
              for (var i = 0; i < groupinfos.length; i++) {
                var device = {
                  friendlyName: groupinfos[i].GroupInfo[0].GroupName[0],
                  deviceId: groupinfos[i].GroupInfo[0].GroupID[0],
                  currentState: groupinfos[i].GroupInfo[0].GroupCapabilityValues[0].split(','),
                  capabilities: groupinfos[i].GroupInfo[0].GroupCapabilityIDs[0].split(',')
                };
                device.internalState = {};
                for (var i = 0; i < device.capabilities.length; i++) {
                  device.internalState[device.capabilities[i]] = device.currentState[i];
                }
                cb(null, device);
              }
            }
          } else {
            console.log(err, data);
          }
        });
      }
    });
  };

  var body = '<u:GetEndDevices xmlns:u="urn:Belkin:service:bridge:1"><DevUDN>%s</DevUDN><ReqListType>PAIRED_LIST</ReqListType></u:GetEndDevices>';
  this.soapAction('urn:Belkin:service:bridge:1', 'GetEndDevices', util.format(body, this.UDN), parseResponse);
};

WemoClient.prototype.setDeviceStatus = function(deviceId, capability, value) {
  var isGroupAction = (deviceId.length === 10) ? 'YES' : 'NO';
  var body = [
    '<u:SetDeviceStatus xmlns:u="urn:Belkin:service:bridge:1">',
    '<DeviceStatusList>',
    '&lt;?xml version=&quot;1.0&quot; encoding=&quot;UTF-8&quot;?&gt;&lt;DeviceStatus&gt;&lt;IsGroupAction&gt;%s&lt;/IsGroupAction&gt;&lt;DeviceID available=&quot;YES&quot;&gt;%s&lt;/DeviceID&gt;&lt;CapabilityID&gt;%s&lt;/CapabilityID&gt;&lt;CapabilityValue&gt;%s&lt;/CapabilityValue&gt;&lt;/DeviceStatus&gt;',
    '</DeviceStatusList>',
    '</u:SetDeviceStatus>'
  ].join('\n');
  this.soapAction('urn:Belkin:service:bridge:1', 'SetDeviceStatus', util.format(body, isGroupAction, deviceId, capability, value));
};

WemoClient.prototype.setBinaryState = function(value) {
  var body = [
    '<u:SetBinaryState xmlns:u="urn:Belkin:service:basicevent:1">',
    '<BinaryState>%s</BinaryState>',
    '</u:SetBinaryState>'
  ].join('\n');
  this.soapAction('urn:Belkin:service:basicevent:1', 'SetBinaryState', util.format(body, value));
};

WemoClient.prototype._onListenerAdded = function(eventName) {
  var serviceType = WemoClient.EventServices[eventName];
  if (serviceType && this.services[serviceType]) {
    this.subscribe(serviceType);
  }
};

WemoClient.prototype.subscribe = function(serviceType) {
  if (!this.services[serviceType]) {
    throw new Error('Service ' + serviceType + ' not supported by ' + this.UDN);
  }
  if (!this.callbackURL) {
    throw new Error('No callbackURL given!');
  }
  if (this.subscriptions[serviceType]) {
    // Subscription already active
    return;
  }

  var options = {
    host: this.host,
    port: this.port,
    path: this.services[serviceType].eventSubURL,
    method: 'SUBSCRIBE',
    headers: {
      TIMEOUT: 'Second-130'
    }
  };

  var renewSubscription = function() {
    if (!this.subscriptions[serviceType]) {
      // Subscription not active for this serviceType
      return;
    }
    options.headers.SID = this.subscriptions[serviceType];
    var req = http.request(options, function(res) {
      setTimeout(renewSubscription.bind(this), 12 * 1000, serviceType);
    }.bind(this));
    req.end();
  };

  var callbackURL = this.callbackURL + '/' + this.UDN;
  options.headers.CALLBACK = '<' + callbackURL + '>';
  options.headers.NT = 'upnp:event';

  this.subscriptions[serviceType] = true;
  var req = http.request(options, function(res) {
    this.subscriptions[serviceType] = res.headers.sid;
    setTimeout(renewSubscription.bind(this), 12 * 1000, serviceType);
  }.bind(this));
  req.end();
};

WemoClient.prototype.unsubscribe = function(serviceType) {
  if (!serviceType) {
    this._unsubscribeAll();
    return;
  }
  if (!this.subscriptions[serviceType]) {
    // No subscription active for this serviceType
    return;
  }

  var options = {
    host: this.host,
    port: this.port,
    path: this.services[serviceType].eventSubURL,
    method: 'UNSUBSCRIBE',
    headers: {
      SID: this.subscriptions[serviceType]
    }
  };

  this.subscriptions[serviceType] = undefined;
  var req = http.request(options);
  req.end();
};

WemoClient.prototype._unsubscribeAll = function() {
  for (var serviceType in this.subscriptions) {
    this.unsubscribe(serviceType);
  }
};

// TODO: Refactor the callback handler.
WemoClient.prototype.handleCallback = function(json) {
  var self = this;
  if (json['e:propertyset']['e:property'][0]['StatusChange']) {
    xml2js.parseString(json['e:propertyset']['e:property'][0]['StatusChange'][0], function (err, xml) {
      if (!err && xml) {
        self.emit('statusChange',
          xml.StateEvent.DeviceID[0]._, // device id
          xml.StateEvent.CapabilityId[0], // capability id
          xml.StateEvent.Value[0] // value
        );
      }
    });
  } else if (json['e:propertyset']['e:property'][0]['BinaryState']) {
    self.emit('binaryState',
      json['e:propertyset']['e:property'][0]['BinaryState'][0].substring(0, 1)
    );
  } else if (json['e:propertyset']['e:property'][0]['InsightParams']) {
    var params = json['e:propertyset']['e:property'][0]['InsightParams'][0].split('|');
    var insightParams = {
      ONSince: params[1],
      OnFor: params[2],
      TodayONTime: params[3]
    };
    self.emit('insightParams',
      params[0], // binary state
      params[7], // instant power
      insightParams
    );
  } else if (json['e:propertyset']['e:property'][0]['attributeList']) {
    xml2js.parseString(json['e:propertyset']['e:property'][0]['attributeList'][0], function (err, xml) {
      if (!err && xml) {
        self.emit('attributeList',
          xml.attribute.name[0], // name
          xml.attribute.value[0], // value
          xml.attribute.prevalue[0], // previous value
          xml.attribute.ts[0] // timestamp
        );
      }
    });
  } else {
    if (self.debug) {
      console.log('Unhandled Event: %j', json);
    }
  }
};