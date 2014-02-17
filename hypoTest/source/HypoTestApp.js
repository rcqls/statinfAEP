enyo.kind({
	name: "App",
	kind: "FittableRows",
	fit: true,
	components:[	 
		{kind: "onyx.MoreToolbar", style:"height:"+cqls.enyo.top+"px;" ,components: [
			{content: "H1: "},
			{kind: "onyx.MenuDecorator", name: "paramMenu", onSelect: "paramSelected", components: [
				{name: "paramMenuName", content: "p"},
				{kind: "onyx.Menu", components: [
					{id:"p", content: "p"},
					{id:"m", content: "mu"}
				]}
			]},
			{kind: "onyx.MenuDecorator", name: "sideMenu",onSelect: "sideSelected", components: [
				{name: "sideMenuName",content: ">"},
				{kind: "onyx.Menu", components: [
					{id:"greater", content: ">"},
					{id:"lower", content: "<"},
					{id:"notequal", content: "!="}
				]}
			]},
			{kind: "onyx.InputDecorator", name: "refInput",style: "width: 5%;",components: [
				{kind: "onyx.Input", name: "refValue", value: "0.15", onchange:"refChanged"}//,
				//{name: "refRight", content: "%"}
			]},
			{content: " Data: n="},
			{kind: "onyx.InputDecorator", name: "nInput",style: "width: 5%;",components: [
				{kind: "onyx.Input", name: "nValue", value: "1000", onchange:"nChanged"}
			]},
			{name: "meanLeft", content: "mean(y)="},
			{kind: "onyx.InputDecorator", name: "meanInput",style: "width: 10%;", components: [
				{kind: "onyx.Input", name: "meanValue", value: "0.171", onchange:"meanChanged"}//,
				//{name: "meanRight", content: "%"}
			]},
			{name: "sdLeft", content: "sd(y)="},
			{kind: "onyx.InputDecorator", name: "sdInput",style: "width: 10%;", components: [
				{kind: "onyx.Input", name: "sdValue", value: "1.2", onchange:"sdChanged"}
			]},
			{kind: "onyx.MenuDecorator", name: "alphaMenu",onSelect: "alphaSelected", components: [
				{content: "Alpha"},
				{kind: "onyx.Menu", components: [
					{id:"0.001", content: "0.1%"},
					{id:"0.01", content: "1%"},
					{id:"0.025", content: "2.5%"},
					{id:"0.05", content: "5%"},
					{id:"0.1", content: "10%"},
					{id:"0.2", content: "20%"},
					{id:"0.5", content: "50%"}
				]}
			]}
		]},
		{tag: "canvas", id: "createjsCanvas",ontap: "onTapCanvas" ,attributes: {width: cqls.i.dim.w, height: cqls.i.dim.h*2}},
		//{id: "trigger-opentip",content: "opentip", attributes: {width: cqls.i.dim.w, height: 20}},
		{kind: "onyx.MoreToolbar",style:"height:"+cqls.enyo.bottom+"px;" ,components: [
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkParam0Curve", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkParam0Mean", onchange:"toggleVisible",checked: true},
				{kind: "onyx.Checkbox", name: "checkParam0SD", onchange:"toggleVisible"}
			]},
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkParam1Curve", onchange:"toggleVisible",checked: true},
				{kind: "onyx.Checkbox", name: "checkParam1Mean", onchange:"toggleVisible",checked: true},
				{kind: "onyx.Checkbox", name: "checkParam1SD", onchange:"toggleVisible"}
			]},
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkDelta0Curve", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkDelta0Mean", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkDelta0SD", onchange:"toggleVisible"}
			]},
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkDelta1Curve", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkDelta1Mean", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkDelta1SD", onchange:"toggleVisible"}
			]},
			{classes: "onyx-sample-tools", components: [			
				{kind: "onyx.Checkbox", name: "checkParamLim", onchange:"toggleVisible",checked: true},
				{kind: "onyx.Checkbox", name: "checkDeltaLim", onchange: "toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkRiskTypeI", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkRiskTypeGen", onchange:"toggleVisible",checked: true}
			]},
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkData", onchange:"toggleVisible"},
				{kind: "onyx.Checkbox", name: "checkPval", onchange: "toggleVisible"} 
			]},
			,
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkTooltip"} 
			]}
		]}
	],
	paramSelected: function(inSender,inEvent) {
		//console.log("param -> "+inEvent.selected.id);
		this.$.paramMenuName.setContent(inEvent.selected.content);
		if(inEvent.selected.content=="p") {
			cqls.enyo.app.$.sdInput.hide();
			cqls.enyo.app.$.sdLeft.hide();
		} else {
			cqls.enyo.app.$.sdInput.show();
			cqls.enyo.app.$.sdLeft.show();
		}
		cqls.m.play.$reset();
		cqls.m.stage.update();
		console.log("H1:"+cqls.enyo.app.$.paramMenuName.content+cqls.enyo.app.$.sideMenuName.content+cqls.enyo.app.$.refValue.getValue());
	},
	sideSelected: function(inSender,inEvent) {
		 this.$.sideMenuName.setContent(inEvent.selected.content);
		 cqls.m.play.$reset();
		cqls.m.stage.update();
		 console.log("H1:"+cqls.enyo.app.$.paramMenuName.content+cqls.enyo.app.$.sideMenuName.content+cqls.enyo.app.$.refValue.getValue());
	},
	refChanged: function(inSender,inEvent) {
		console.log("H1:"+cqls.enyo.app.$.paramMenuName.content+cqls.enyo.app.$.sideMenuName.content+cqls.enyo.app.$.refValue.getValue());
	},
	alphaSelected: function(inSender,inEvent) {
		cqls.m.play.$setAlpha(parseFloat(inEvent.selected.id));
		cqls.m.play.$reset();
		cqls.m.stage.update();
	},
	toggleVisible: function(inSender, inEvent) {
		cqls.m.play.$updateVisible();
	},
	onTapCanvas: function(inSender, inEvent) {
		var p = enyo.getPosition();
		//cqls.f.onTap(p["clientX"]/cqls.m.stage.scaleX,(p["clientY"]-cqls.enyo.top)/cqls.m.stage.scaleY);
	}

	//,
	// toggleFullscreen: function(inSender, inEvent) {
	// 	var targetControl = this;
		
	// 	// If _targetControl_ is currently fullscreen, cancel fullscreen
	// 	if (targetControl.isFullscreen()) {
	// 		targetControl.cancelFullscreen();
		
	// 	// If _targetControl_ is not currently fullscreen, request fullscreen
	// 	} else {
	// 		targetControl.requestFullscreen();
	// 	}
	// }
});
