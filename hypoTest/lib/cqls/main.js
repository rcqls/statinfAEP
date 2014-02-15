	// m: main, s: sim, h: hist, i: interface, f: functions
	var cqls={
				m: {
					xylimMore:0.01,
					xmin:-5.0,xmax:5.0,ymax:0.5,qmin:0.0001,qmax:0.9999,
					nbsSim: {//to remove
						"1":[1,5,10,30,100,200,300,500,1000,1500,3000],
						"10":[10,50,100,200,300,500,1000,1500,3000],
						"30":[30,150,300,600,900,1500,3000],
						"100":[100,500,1000,1500,3000],
						"1000":[1000,3000]
					},
					nbSimMax:3000
				},
				s: {}, 
				h: {},
				i: {
					dim: {w:1200,h:300},
					count: 3, keepAspectRatio: 0, 
					//indSim:3, indN:2, 
					ptSize:3, loop:false, pause:false, anim:true , prior: false, allowLevelChange:true,
					zoom: {},
					scaleTime: 1.0
				},
				enyo: {top: 60, bottom:60},
				f: {}
			};

    //////////////////////////////////////////////
    // Functions
	cqls.f.resizeCanvas=function() { 
		// browser viewport size
		var w = window.innerWidth;
		var h = window.innerHeight-cqls.enyo.top-cqls.enyo.bottom;


		if (cqls.i.keepAspectRatio) {
		    // keep aspect ratio
		    var scale = Math.min(w / cqls.m.ow, h / cqls.m.oh);
		    cqls.m.stage.scaleX = scale;
		    cqls.m.stage.scaleY = scale;

		   // adjust canvas size
		   	cqls.m.stage.canvas.width = cqls.m.ow * scale;
		  	cqls.m.stage.canvas.height = cqls.m.oh * scale;
		} else {
		    // scale to exact fit
		    cqls.m.stage.scaleX = w / cqls.m.ow;
		    cqls.m.stage.scaleY = h / cqls.m.oh;

		    // adjust canvas size
		    cqls.m.stage.canvas.width = cqls.m.ow * cqls.m.stage.scaleX;
		    cqls.m.stage.canvas.height = cqls.m.oh * cqls.m.stage.scaleY;
		}

		//console.log(cqls.m.stage.canvas.width+","+cqls.m.stage.canvas.height);
	    cqls.m.stage.update();
	}

	cqls.f.onTap=function(x,y) {
		if(cqls.m.play.graphExp.$zoomActive()) {
			if(cqls.m.play.graphExp.$hitZoom(x,y)!="none") {
				cqls.m.play.$reset();
				cqls.m.stage.update();
			}
			return
		}
		if(y < cqls.h.plot.dim["$[]"]("y")) {
			 
			if(cqls.i.anim) {
	    		cqls.m.play.$setMLevel(x > cqls.s.plot.dim["$[]"]("w")/2 ? 1 : -1);
	    	} else { 
		    	if(x > cqls.s.plot.dim["$[]"]("w")/2) cqls.i.count+=1; else cqls.i.count -=1;
		    	if(cqls.i.count<0) cqls.i.count=0;
		    	if(cqls.i.count>4) cqls.i.count=4;
	    	}
		} else {
			 
	   		if(x > cqls.s.plot.dim["$[]"]("w")/2) cqls.m.play.histCur.$level(1); else cqls.m.play.histCur.$level(-1);
	   		//if(cqls.i.allowLevelChange) { 
		    	if(!cqls.i.anim) cqls.m.play.histCur.$draw();
		    	else {
		    		if(cqls.i.paused) cqls.m.play.$drawHist();
		    	}
		    //}
		    cqls.m.stage.update();
	    }
	    
	}

	///////////////////////////
	// Main function to call
	function aep() {

		// console.log(Opal.Cqls.$range(0,1,.1));
		// console.log(Opal.Cqls.$seq(0,1,11));
		// console.log(jStat.seq(0,1,11));

		//cqls.d=Opal.Cqls.Timing["$[]"](10,20,14);
		// cqls.d=Opal.Cqls.Timing.$new([10,20,12]);
		// console.log(cqls.d.t);
		// console.log(cqls.d.d);
		// console.log(cqls.d.$start());
		// console.log(cqls.d.$stop());

		////// test on Distribution
		// cqls.m.exp=Opal.Cqls.Distribution.$new();
		// cqls.m.exp.$set("binomial",[2,.5]);
		// console.log(cqls.m.exp.$pdf([-1,1,1.15]));
		// cqls.m.dist=Opal.Cqls.Convolution.$power(cqls.m.exp,3);
		
		//cqls.m.dist=new BinomialDistribution(5,.15);
		cqls.m.dist=new LocationScaleDistribution(new BernoulliDistribution(.15),-.15/Math.sqrt(.15*.85),1/Math.sqrt(.15*.85));
		console.log(cqls.m.dist.minValue());
		console.log(cqls.m.dist.maxValue());
		console.log(cqls.m.dist.type()==CONT);
		console.log(cqls.m.dist.step());
		console.log(cqls.m.dist.values());
		cqls.m.dist2 = new PowerDistribution(cqls.m.dist,2);
		console.log(cqls.m.dist2.minValue());
		console.log(cqls.m.dist2.maxValue());
		console.log(cqls.m.dist2.type()==CONT);
		console.log(cqls.m.dist2.step());
		console.log(cqls.m.dist2.values());

		cqls.m.dist3=Opal.Cqls.Convolution.$power(cqls.m.dist2,4);
		console.log(cqls.m.dist3.values());
		console.log(cqls.m.dist3.values().map(cqls.m.dist3.density));
		console.log(cqls.m.dist3.values().map(cqls.m.dist3.density).reduce(function(a, b) {
		    return a + b;
		}));
				// d2=Distribution.new
				// d2.setAsTransfOf(d,{name: :square, args: []})

		// cqls.m.exp2=Opal.Cqls.Distribution.$new();
		// cqls.m.exp2.$setAsTransfOf(cqls.m.exp,Opal.hash2(["name","args"],{name: "square",args: [2]}));
		// cqls.m.dist=new LocationScaleDistribution(new Convolution(new UniformDistribution(0,1),2),0,.5);
		// console.log(cqls.m.dist.minValue());
		// console.log(cqls.m.dist.maxValue());
		// console.log(cqls.m.dist.type()==CONT);
		// console.log(cqls.m.dist.step());

		// console.log(cqls.m.dist.density(0));
		// console.log(cqls.m.dist.density(.5));
		// console.log(cqls.m.dist.density(1));
		// console.log(cqls.m.dist.density(2));
		// console.log(cqls.m.dist.density(3));
		// console.log(cqls.m.dist.density(4));
		// console.log(cqls.m.dist.density(5));
		// console.log(cqls.m.dist.density(6));
		// console.log(cqls.m.dist.density(7));
		// console.log(cqls.m.dist.density(8));
		// console.log(cqls.m.dist.density(9));

		// cqls.m.exp2.$set("binomial",[8,.5]);
		// console.log(cqls.m.exp2.$pdf([0,1,2,3,4]));
		// console.log(cqls.m.exp2.$quantile(0));
		// console.log(cqls.m.exp2.$quantile(1));
		// console.log(cqls.m.exp2.$minValue());
		// console.log(cqls.m.exp2.$maxValue());
		// console.log(cqls.m.exp2.$pdf([0,1,2,3,4]));
		// console.log(cqls.m.exp2.distrib.step());

		// cqls.m.exp.$set("binomial",[1,0.5]);
		// cqls.m.exp3=Opal.Cqls.Distribution.$new();
		// cqls.m.exp3.$set("binomial",[10,0.5]);
		// cqls.m.exp2=Opal.Cqls.Distribution.$new();
		// cqls.m.exp2.$setAsTransfOf(cqls.m.exp,Opal.hash2(["name","args"],{name: "mean",args: [10]}));
		// console.log(cqls.m.exp2.distrib.dist().density(1));
		// console.log(cqls.m.exp2.distrib.step());
		// console.log(cqls.m.exp2.mode);
		// console.log(cqls.m.exp2.$pdf([0,1/10,2/10]));

		// console.log(cqls.m.exp3.$pdf([0,1,2]));
		// console.log(cqls.m.exp2.$mean());
		// console.log(cqls.m.exp3.$mean());
		// console.log(cqls.m.exp2.$bounds());
		// console.log(cqls.m.exp3.$bounds());
		// console.log(cqls.m.exp.$variance());
		// console.log(cqls.m.exp2.$quantile(0.95));
		// console.log(cqls.m.exp3.$quantile(0.95));

	    cqls.m.canvas = document.getElementById("createjsCanvas");
	    cqls.m.ow=cqls.m.canvas.width;cqls.m.oh=cqls.m.canvas.height;

		//Run function when browser resizes
		window.onresize=function() {cqls.f.resizeCanvas();};

	    cqls.m.stage = new createjs.Stage(cqls.m.canvas);
	    //cqls.m.stage.autoClear = true;
	    createjs.Touch.enable(cqls.m.stage);

	    cqls.s.plot=Opal.Cqls.Plot.$new();
	    cqls.m.stage.addChild(cqls.s.plot.parent);



	    //Listener for sim plot
     //    cqls.s.plot.frame.addEventListener("click", function(evt) {
	    // 	if(cqls.i.anim) {
	    // 		if(evt.stageX > cqls.s.plot.dim["$[]"]("w")/2) cqls.i.indSim+=1; else cqls.i.indSim -=1;
		   //  	if(cqls.i.indSim<0) cqls.i.indSim=0;
		   //  	if(cqls.i.indSim>cqls.m.nbsSim[cqls.m.play.n.toString()].length-1) cqls.i.indSim=cqls.m.nbsSim[cqls.m.play.n.toString()].length-1;

	    // 	} else { 
		   //  	if(evt.stageX > cqls.s.plot.dim["$[]"]("w")/2) cqls.i.count+=1; else cqls.i.count -=1;
		   //  	if(cqls.i.count<0) cqls.i.count=0;
		   //  	if(cqls.i.count>4) cqls.i.count=4;
	    // 	}
	    // });


	    ///cqls.h.plot.init();
	    cqls.h.plot=Opal.Cqls.Plot.$new(Opal.hash2(["x","y","w","h"],{x:0,y:300,w:cqls.i.dim.w,h:cqls.i.dim.h}),Opal.hash2(["bg"],{bg:"#8888FF"}));
	    cqls.m.stage.addChild(cqls.h.plot.parent);

	    // Listener for hist plot
	   	// cqls.h.plot.frame.addEventListener("click", function(evt) {
	   	// 	if(evt.stageX > cqls.s.plot.dim["$[]"]("w")/2) cqls.m.play.histCur.$level(1); else cqls.m.play.histCur.$level(-1);
	   	// 	if(cqls.i.allowLevelChange) { 
		   //  	if(!cqls.i.anim) cqls.m.play.histCur.$draw();
		   //  	else {
		   //  		if(cqls.i.paused) cqls.m.play.$drawHist();
		   //  	}
		   //  }
		   //  cqls.m.stage.update();
	    // });
		

	   	cqls.m.play=Opal.Cqls.Play.$new();

		 
		
		//Initial call 
		cqls.f.resizeCanvas();
		cqls.enyo.app.$.sdInput.hide();cqls.enyo.app.$.sdLeft.hide();
		//cqls.enyo.app.$.alphaMenu.hide();
		//cqls.enyo.app.$.pauseButton.hide();
	}

