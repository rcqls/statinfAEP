enyo.kind({
	name: "App",
	kind: "FittableRows",
	fit: true,
	components:[	 
		{kind: "onyx.MoreToolbar", style:"height:"+cqls.enyo.top+"px;" ,components: [
			{kind: "onyx.Button", content: "Add", name: "addButton", ontap: "simTap"},
			{kind: "onyx.Button", content: "Pause", name: "pauseButton", ontap: "pauseTap"},
			{kind: "onyx.MenuDecorator", name: "distMenu", onSelect: "distribSelected", components: [
				{content: "D."},
				{kind: "onyx.Menu", components: [
					{id:"discreteUniform", content: "Uniform Discrete"},
					{id:"bernoulli", content: "Bernoulli"},
					{id:"binomial", content: "Binomial"},
					{classes: "onyx-menu-divider"},
					{id:"stdNormal", content: "N(0,1)"},
					{id:"uniform", content: "Uniform"},
					{id:"normal", content: "Normal"},
					{id:"t", content: "Student"},
					{id:"chi2", content: "Chi2"},
					{classes: "onyx-menu-divider"},
					{id:"cauchy", content: "Cauchy"},
				]}
			]},
			{kind: "onyx.MenuDecorator", name: "transfMenu",onSelect: "transfSelected", components: [
				{content: "T."},
				{kind: "onyx.Menu", components: [
					{id:"none", content: "None"},
					{id:"center", content: "Center"},
					{id:"locationScale", content: "Center-Reduce"},
					{id:"square", content: "Square"},
					{classes: "onyx-menu-divider"},
					{id:"sum", content: "Sample Sum"},
					{id:"mean", content: "Sample Mean"},
					{id:"stdMean", content: "Standardized Mean Error"}//,
					//{id:"sumOfSq", content: "Sum of squares"}
				]}
			]},
			{kind: "onyx.MenuDecorator",name: "nMenu",onSelect: "nSelected", components: [
				{content: "n"},
				{kind: "onyx.Menu", components: [
					{id:"2", content: "2"},
					{id:"3", content: "3"},
					{id:"4", content: "4"},
					{id:"5", content: "5"},
					{id:"10", content: "10"},
					{id:"15", content: "15"},
					{id:"16", content: "16"},
					{id:"20", content: "20"},
					{id:"25", content: "25"},
					{id:"30", content: "30"},
					{id:"32", content: "32"},
					{id:"50", content: "50"},
					{id:"64", content: "64"},
					{id:"100", content: "100"},
					{id:"128", content: "128"},
					{id:"256", content: "256"},
					{id:"500", content: "500"},
					{id:"512", content: "512"},
					{id:"1000", content: "1000"},
					{id:"1024", content: "1024"}
				]}
			]},
			{kind: "onyx.Button", content: "Zoom", name: "zoomButton",ontap: "zoomTap"}
		]},
		//{kind: "enyo.Scroller", id: "canvasContainer",components: [
			{tag: "canvas", id: "createjsCanvas",ontap: "onTapCanvas" ,attributes: {width: cqls.i.dim.w, height: cqls.i.dim.h*2}}
		//]}
		,
		{kind: "onyx.MoreToolbar",style:"height:"+cqls.enyo.bottom+"px;" ,components: [
			{kind: "onyx.ToggleButton", ontap: "toggleAnimMode",value:true},
			{classes: "onyx-sample-tools", components: [
				{kind: "onyx.Checkbox", name: "checkTCL", onchange:"toggleTCL"},
				{kind: "onyx.Checkbox", name: "checkHistCurve", onchange: "toggleHistCurve"},
				{kind: "onyx.Checkbox", name: "checkSummary", onchange: "toggleSummary"} 
			]}	
		]}
	],
	distribSelected: function(inSender,inEvent) {
		cqls.m.play.$setDistrib(inEvent.selected.id);
		cqls.m.play.$reset();
		cqls.m.stage.update();
	},
	transfSelected: function(inSender,inEvent) {
		cqls.m.play.$setTransf(inEvent.selected.id);
		if(["none","locationScale","center"].indexOf(inEvent.selected.id) > 0) this.$.nMenu.hide();
		else this.$.nMenu.show();
		cqls.m.play.$reset();
		cqls.m.stage.update();
	},
	nSelected: function(inSender,inEvent) {
		cqls.m.play.$setN(parseInt(inEvent.selected.id));
		cqls.m.play.$reset();
		cqls.m.stage.update();
	},
	simTap: function(inSender, inEvent) {
		// if(inSender.hasClass("active"))  inSender.removeClass("active")
		// else inSender.addClass("active");
		cqls.i.loop=!cqls.i.loop;
		inSender.addRemoveClass("active",cqls.i.loop);
		if(cqls.i.loop) {
			this.$.pauseButton.show();
			this.$.distMenu.hide();
			this.$.transfMenu.hide();
			this.$.nMenu.hide();
			cqls.f.updateDemo();
		} else {
			this.$.pauseButton.hide();
			this.$.distMenu.show();
			this.$.transfMenu.show();
		}
	},
	pauseTap: function(inSender, inEvent) {
		cqls.i.paused=!cqls.i.paused;
		inSender.addRemoveClass("active",cqls.i.paused);
		createjs.Ticker.setPaused(cqls.i.paused);
		this.$.addButton.disabled=cqls.i.paused;
		this.$.zoomButton.disabled=cqls.i.paused;
	},
	zoomTap: function(inSender, inEvent) {
		cqls.m.play.graphExp.$toggleZoomTo(cqls.m.play.plotExp);
		cqls.m.stage.update();
	},
	toggleAnimMode: function(inSender, inEvent) {
		cqls.i.anim=inSender.getValue();
		cqls.m.stage.update();
	},
	toggleHistCurve: function(inSender, inEvent) {
		cqls.m.play.histCur.curveShape.visible=inSender.getValue();
	},
	toggleTCL: function(inSender, inEvent) {
		cqls.m.play.$showTCL(inSender.getValue());
		cqls.m.stage.update();
	},
	toggleSummary: function(inSender, inEvent) {
		cqls.m.play.$drawSummary();
		cqls.m.play.$showSummary(inSender.getValue());
		cqls.m.stage.update();
	},
	onTapCanvas: function(inSender, inEvent) {
		var p = enyo.getPosition();
		cqls.f.onTap(p["clientX"]/cqls.m.stage.scaleX,(p["clientY"]-cqls.enyo.top)/cqls.m.stage.scaleY);
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
