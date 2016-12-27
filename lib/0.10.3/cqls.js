(function(undefined) {
  // @note
  //   A few conventions for the documentation of this file:
  //   1. Always use "//" (in contrast with "/**/")
  //   2. The syntax used is Yardoc (yardoc.org), which is intended for Ruby (se below)
  //   3. `@param` and `@return` types should be preceded by `JS.` when referring to
  //      JavaScript constructors (e.g. `JS.Function`) otherwise Ruby is assumed.
  //   4. `nil` and `null` being unambiguous refer to the respective
  //      objects/values in Ruby and JavaScript
  //   5. This is still WIP :) so please give feedback and suggestions on how
  //      to improve or for alternative solutions
  //
  //   The way the code is digested before going through Yardoc is a secret kept
  //   in the docs repo (https://github.com/opal/docs/tree/master).

  if (typeof(this.Opal) !== 'undefined') {
    console.warn('Opal already loaded. Loading twice can cause troubles, please fix your setup.');
    return this.Opal;
  }

  var nil;

  // The actual class for BasicObject
  var BasicObject;

  // The actual Object class.
  // The leading underscore is to avoid confusion with window.Object()
  var _Object;

  // The actual Module class
  var Module;

  // The actual Class class
  var Class;

  // Constructor for instances of BasicObject
  function BasicObject_alloc(){}

  // Constructor for instances of Object
  function Object_alloc(){}

  // Constructor for instances of Class
  function Class_alloc(){}

  // Constructor for instances of Module
  function Module_alloc(){}

  // Constructor for instances of NilClass (nil)
  function NilClass_alloc(){}

  // The Opal object that is exposed globally
  var Opal = this.Opal = {};

  // All bridged classes - keep track to donate methods from Object
  var bridges = {};

  // TopScope is used for inheriting constants from the top scope
  var TopScope = function(){};

  // Opal just acts as the top scope
  TopScope.prototype = Opal;

  // To inherit scopes
  Opal.constructor = TopScope;

  // List top scope constants
  Opal.constants = [];

  // This is a useful reference to global object inside ruby files
  Opal.global = this;

  // Configure runtime behavior with regards to require and unsupported fearures
  Opal.config = {
    missing_require_severity: 'error', // error, warning, ignore
    unsupported_features_severity: 'warning' // error, warning, ignore
  }

  // Minify common function calls
  var $hasOwn = Opal.hasOwnProperty;
  var $slice  = Opal.slice = Array.prototype.slice;

  // Nil object id is always 4
  var nil_id = 4;

  // Generates even sequential numbers greater than 4
  // (nil_id) to serve as unique ids for ruby objects
  var unique_id = nil_id;

  // Return next unique id
  Opal.uid = function() {
    unique_id += 2;
    return unique_id;
  };

  // Table holds all class variables
  Opal.cvars = {};

  // Globals table
  Opal.gvars = {};

  // Exit function, this should be replaced by platform specific implementation
  // (See nodejs and phantom for examples)
  Opal.exit = function(status) { if (Opal.gvars.DEBUG) console.log('Exited with status '+status); };

  // keeps track of exceptions for $!
  Opal.exceptions = [];

  // @private
  // Pops an exception from the stack and updates `$!`.
  Opal.pop_exception = function() {
    Opal.gvars["!"] = Opal.exceptions.pop() || nil;
  }


  // Constants
  // ---------

  // Get a constant on the given scope. Every class and module in Opal has a
  // scope used to store, and inherit, constants. For example, the top level
  // `Object` in ruby has a scope accessible as `Opal.Object.$$scope`.
  //
  // To get the `Array` class using this scope, you could use:
  //
  //     Opal.Object.$$scope.get("Array")
  //
  // If a constant with the given name cannot be found, then a dispatch to the
  // class/module's `#const_method` is called, which by default will raise an
  // error.
  //
  // @param name [String] the name of the constant to lookup
  // @return [Object]
  //
  Opal.get = function(name) {
    var constant = this[name];

    if (constant == null) {
      return this.base.$const_get(name);
    }

    return constant;
  };

  // Create a new constants scope for the given class with the given
  // base. Constants are looked up through their parents, so the base
  // scope will be the outer scope of the new klass.
  //
  // @param base_scope [$$scope] the scope in which the new scope should be created
  // @param klass      [Class]
  // @param id         [String, null] the name of the newly created scope
  //
  Opal.create_scope = function(base_scope, klass, id) {
    var const_alloc = function() {};
    var const_scope = const_alloc.prototype = new base_scope.constructor();

    klass.$$scope       = const_scope;
    klass.$$base_module = base_scope.base;

    const_scope.base        = klass;
    const_scope.constructor = const_alloc;
    const_scope.constants   = [];

    if (id) {
      Opal.cdecl(base_scope, id, klass);
      const_alloc.displayName = id+"_scope_alloc";
    }
  };

  // Constant assignment, see also `Opal.cdecl`
  //
  // @param base_module [Module, Class] the constant namespace
  // @param name        [String] the name of the constant
  // @param value       [Object] the value of the constant
  //
  // @example Assigning a namespaced constant
  //   self::FOO = 'bar'
  //
  // @example Assigning with Module#const_set
  //   Foo.const_set :BAR, 123
  //
  Opal.casgn = function(base_module, name, value) {
    function update(klass, name) {
      klass.$$name = name;

      for (name in klass.$$scope) {
        var value = klass.$$scope[name];

        if (value.$$name === nil && (value.$$is_class || value.$$is_module)) {
          update(value, name)
        }
      }
    }

    var scope = base_module.$$scope;

    if (value.$$is_class || value.$$is_module) {
      // Only checking _Object prevents setting a const on an anonymous class
      // that has a superclass that's not Object
      if (value.$$is_class || value.$$base_module === _Object) {
        value.$$base_module = base_module;
      }

      if (value.$$name === nil && value.$$base_module.$$name !== nil) {
        update(value, name);
      }
    }

    scope.constants.push(name);
    scope[name] = value;

    // If we dynamically declare a constant in a module,
    // we should populate all the classes that include this module
    // with the same constant
    if (base_module.$$is_module && base_module.$$dep) {
      for (var i = 0; i < base_module.$$dep.length; i++) {
        var dep = base_module.$$dep[i];
        Opal.casgn(dep, name, value);
      }
    }

    return value;
  };

  // Constant declaration
  //
  // @example
  //   FOO = :bar
  //
  // @param base_scope [$$scope] the current scope
  // @param name       [String] the name of the constant
  // @param value      [Object] the value of the constant
  Opal.cdecl = function(base_scope, name, value) {
    if ((value.$$is_class || value.$$is_module) && value.$$orig_scope == null) {
      value.$$name = name;
      value.$$orig_scope = base_scope;
      // Here we should explicitly set a base module
      // (a module where the constant was initially defined)
      value.$$base_module = base_scope.base;
      base_scope.constructor[name] = value;
    }

    base_scope.constants.push(name);
    return base_scope[name] = value;
  };


  // Modules & Classes
  // -----------------

  // A `class Foo; end` expression in ruby is compiled to call this runtime
  // method which either returns an existing class of the given name, or creates
  // a new class in the given `base` scope.
  //
  // If a constant with the given name exists, then we check to make sure that
  // it is a class and also that the superclasses match. If either of these
  // fail, then we raise a `TypeError`. Note, `superclass` may be null if one
  // was not specified in the ruby code.
  //
  // We pass a constructor to this method of the form `function ClassName() {}`
  // simply so that classes show up with nicely formatted names inside debuggers
  // in the web browser (or node/sprockets).
  //
  // The `base` is the current `self` value where the class is being created
  // from. We use this to get the scope for where the class should be created.
  // If `base` is an object (not a class/module), we simple get its class and
  // use that as the base instead.
  //
  // @param base        [Object] where the class is being created
  // @param superclass  [Class,null] superclass of the new class (may be null)
  // @param id          [String] the name of the class to be created
  // @param constructor [JS.Function] function to use as constructor
  //
  // @return new [Class]  or existing ruby class
  //
  Opal.klass = function(base, superclass, name, constructor) {
    var klass, bridged, alloc;

    // If base is an object, use its class
    if (!base.$$is_class && !base.$$is_module) {
      base = base.$$class;
    }

    // If the superclass is a function then we're bridging a native JS class
    if (typeof(superclass) === 'function') {
      bridged = superclass;
      superclass = _Object;
    }

    // Try to find the class in the current scope
    klass = base.$$scope[name];

    // If the class exists in the scope, then we must use that
    if (klass && klass.$$orig_scope === base.$$scope) {
      // Make sure the existing constant is a class, or raise error
      if (!klass.$$is_class) {
        throw Opal.TypeError.$new(name + " is not a class");
      }

      // Make sure existing class has same superclass
      if (superclass && klass.$$super !== superclass) {
        throw Opal.TypeError.$new("superclass mismatch for class " + name);
      }

      return klass;
    }

    // Class doesnt exist, create a new one with given superclass...

    // Not specifying a superclass means we can assume it to be Object
    if (superclass == null) {
      superclass = _Object;
    }

    // If bridged the JS class will also be the alloc function
    alloc = bridged || Opal.boot_class_alloc(name, constructor, superclass);

    // Create the class object (instance of Class)
    klass = Opal.setup_class_object(name, alloc, superclass.$$name, superclass.constructor);

    // @property $$super the superclass, doesn't get changed by module inclusions
    klass.$$super = superclass;

    // @property $$parent direct parent class
    //                    starts with the superclass, after klass inclusion is
    //                    the last included klass
    klass.$$parent = superclass;

    // Every class gets its own constant scope, inherited from current scope
    Opal.create_scope(base.$$scope, klass, name);

    // Name new class directly onto current scope (Opal.Foo.Baz = klass)
    base[name] = klass;

    if (bridged) {
      Opal.bridge(klass, alloc);
    }
    else {
      // Copy all parent constants to child, unless parent is Object
      if (superclass !== _Object && superclass !== BasicObject) {
        Opal.donate_constants(superclass, klass);
      }

      // Call .inherited() hook with new class on the superclass
      if (superclass.$inherited) {
        superclass.$inherited(klass);
      }
    }

    return klass;
  };

  // Boot a base class (makes instances).
  //
  // @param name [String,null] the class name
  // @param constructor [JS.Function] the class' instances constructor/alloc function
  // @param superclass  [Class,null] the superclass object
  // @return [JS.Function] the consturctor holding the prototype for the class' instances
  Opal.boot_class_alloc = function(name, constructor, superclass) {
    if (superclass) {
      var alloc_proxy = function() {};
      alloc_proxy.prototype  = superclass.$$proto || superclass.prototype;
      constructor.prototype = new alloc_proxy();
    }

    if (name) {
      constructor.displayName = name+'_alloc';
    }

    constructor.prototype.constructor = constructor;

    return constructor;
  };

  // Adds common/required properties to class object (as in `Class.new`)
  //
  // @param name  [String,null] The name of the class
  //
  // @param alloc [JS.Function] The constructor of the class' instances
  //
  // @param superclass_name [String,null]
  //   The name of the super class, this is
  //   usefule to build the `.displayName` of the singleton class
  //
  // @param superclass_alloc [JS.Function]
  //   The constructor of the superclass from which the singleton_class is
  //   derived.
  //
  // @return [Class]
  Opal.setup_class_object = function(name, alloc, superclass_name, superclass_alloc) {
    // Grab the superclass prototype and use it to build an intermediary object
    // in the prototype chain.
    var superclass_alloc_proxy = function() {};
        superclass_alloc_proxy.prototype = superclass_alloc.prototype;
        superclass_alloc_proxy.displayName = superclass_name;

    var singleton_class_alloc = function() {}
        singleton_class_alloc.prototype = new superclass_alloc_proxy();

    // The built class is the only instance of its singleton_class
    var klass = new singleton_class_alloc();

    // @property $$alloc This is the constructor of instances of the current
    //                   class. Its prototype will be used for method lookup
    klass.$$alloc = alloc;

    klass.$$name = name || nil;

    // @property $$id Each class is assigned a unique `id` that helps
    //                comparation and implementation of `#object_id`
    klass.$$id = Opal.uid();

    // Set a displayName for the singleton_class
    singleton_class_alloc.displayName = "#<Class:"+(name || ("#<Class:"+klass.$$id+">"))+">";

    // @property $$proto This is the prototype on which methods will be defined
    klass.$$proto = alloc.prototype;

    // @property $$proto.$$class Make available to instances a reference to the
    //                           class they belong to.
    klass.$$proto.$$class = klass;

    // @property constructor keeps a ref to the constructor, but apparently the
    //                       constructor is already set on:
    //
    //                          `var klass = new constructor` is called.
    //
    //                       Maybe there are some browsers not abiding (IE6?)
    klass.constructor = singleton_class_alloc;

    // @property $$is_class Clearly mark this as a class
    klass.$$is_class = true;

    // @property $$class Classes are instances of the class Class
    klass.$$class    = Class;

    // @property $$inc included modules
    klass.$$inc = [];

    return klass;
  };

  // Define new module (or return existing module). The given `base` is basically
  // the current `self` value the `module` statement was defined in. If this is
  // a ruby module or class, then it is used, otherwise if the base is a ruby
  // object then that objects real ruby class is used (e.g. if the base is the
  // main object, then the top level `Object` class is used as the base).
  //
  // If a module of the given name is already defined in the base, then that
  // instance is just returned.
  //
  // If there is a class of the given name in the base, then an error is
  // generated instead (cannot have a class and module of same name in same base).
  //
  // Otherwise, a new module is created in the base with the given name, and that
  // new instance is returned back (to be referenced at runtime).
  //
  // @param  base [Module, Class] class or module this definition is inside
  // @param  id   [String] the name of the new (or existing) module
  //
  // @return [Module]
  Opal.module = function(base, name) {
    var module;

    if (!base.$$is_class && !base.$$is_module) {
      base = base.$$class;
    }

    if ($hasOwn.call(base.$$scope, name)) {
      module = base.$$scope[name];

      if (!module.$$is_module && module !== _Object) {
        throw Opal.TypeError.$new(name + " is not a module");
      }
    }
    else {
      module = Opal.module_allocate(Module);
      Opal.create_scope(base.$$scope, module, name);
    }

    return module;
  };

  // The implementation for Module#initialize
  // @param module [Module]
  // @param block [Proc,nil]
  // @return nil
  Opal.module_initialize = function(module, block) {
    if (block !== nil) {
      var block_self = block.$$s;
      block.$$s = null;
      block.call(module);
      block.$$s = block_self;
    }
    return nil;
  };

  // Internal function to create a new module instance. This simply sets up
  // the prototype hierarchy and method tables.
  //
  Opal.module_allocate = function(superclass) {
    var mtor = function() {};
    mtor.prototype = superclass.$$alloc.prototype;

    function module_constructor() {}
    module_constructor.prototype = new mtor();

    var module = new module_constructor();
    var module_prototype = {};

    // @property $$id Each class is assigned a unique `id` that helps
    //                comparation and implementation of `#object_id`
    module.$$id = Opal.uid();

    // Set the display name of the singleton prototype holder
    module_constructor.displayName = "#<Class:#<Module:"+module.$$id+">>"

    // @property $$proto This is the prototype on which methods will be defined
    module.$$proto = module_prototype;

    // @property constructor
    //   keeps a ref to the constructor, but apparently the
    //   constructor is already set on:
    //
    //      `var module = new constructor` is called.
    //
    //   Maybe there are some browsers not abiding (IE6?)
    module.constructor = module_constructor;

    // @property $$is_module Clearly mark this as a module
    module.$$is_module = true;
    module.$$class     = Module;

    // @property $$super
    //   the superclass, doesn't get changed by module inclusions
    module.$$super = superclass;

    // @property $$parent
    //   direct parent class or module
    //   starts with the superclass, after module inclusion is
    //   the last included module
    module.$$parent = superclass;

    // @property $$inc included modules
    module.$$inc = [];

    // mark the object as a module
    module.$$is_module = true;

    // initialize dependency tracking
    module.$$dep = [];

    // initialize the name with nil
    module.$$name = nil;

    return module;
  };

  // Return the singleton class for the passed object.
  //
  // If the given object alredy has a singleton class, then it will be stored on
  // the object as the `$$meta` property. If this exists, then it is simply
  // returned back.
  //
  // Otherwise, a new singleton object for the class or object is created, set on
  // the object at `$$meta` for future use, and then returned.
  //
  // @param object [Object] the ruby object
  // @return [Class] the singleton class for object
  Opal.get_singleton_class = function(object) {
    if (object.$$meta) {
      return object.$$meta;
    }

    if (object.$$is_class || object.$$is_module) {
      return Opal.build_class_singleton_class(object);
    }

    return Opal.build_object_singleton_class(object);
  };

  // Build the singleton class for an existing class. Class object are built
  // with their singleton class already in the prototype chain and inheriting
  // from their superclass object (up to `Class` itself).
  //
  // NOTE: Actually in MRI a class' singleton class inherits from its
  // superclass' singleton class which in turn inherits from Class.
  //
  // @param klass [Class]
  // @return [Class]
  Opal.build_class_singleton_class = function(object) {
    var alloc, superclass, klass;

    if (object.$$meta) {
      return object.$$meta;
    }

    // The constructor and prototype of the singleton_class instances is the
    // current class constructor and prototype.
    alloc = object.constructor;

    // The singleton_class superclass is the singleton_class of its superclass;
    // but BasicObject has no superclass (its `$$super` is null), thus we
    // fallback on `Class`.
    superclass = object === BasicObject ? Class : Opal.build_class_singleton_class(object.$$super);

    klass = Opal.setup_class_object(null, alloc, superclass.$$name, superclass.constructor);
    klass.$$super = superclass;
    klass.$$parent = superclass;

    // The singleton_class retains the same scope as the original class
    Opal.create_scope(object.$$scope, klass);

    klass.$$is_singleton = true;
    klass.$$singleton_of = object;

    return object.$$meta = klass;
  };

  // Build the singleton class for a Ruby (non class) Object.
  //
  // @param object [Object]
  // @return [Class]
  Opal.build_object_singleton_class = function(object) {
    var superclass = object.$$class,
        name = "#<Class:#<" + superclass.$$name + ":" + superclass.$$id + ">>";

    var alloc = Opal.boot_class_alloc(name, function(){}, superclass)
    var klass = Opal.setup_class_object(name, alloc, superclass.$$name, superclass.constructor);

    klass.$$super  = superclass;
    klass.$$parent = superclass;
    klass.$$class  = superclass.$$class;
    klass.$$scope  = superclass.$$scope;
    klass.$$proto  = object;

    klass.$$is_singleton = true;
    klass.$$singleton_of = object;

    return object.$$meta = klass;
  };

  // Bridges a single method.
  Opal.bridge_method = function(target, from, name, body) {
    var ancestors, i, ancestor, length;

    ancestors = target.$$bridge.$ancestors();

    // order important here, we have to check for method presence in
    // ancestors from the bridged class to the last ancestor
    for (i = 0, length = ancestors.length; i < length; i++) {
      ancestor = ancestors[i];

      if ($hasOwn.call(ancestor.$$proto, name) &&
          ancestor.$$proto[name] &&
          !ancestor.$$proto[name].$$donated &&
          !ancestor.$$proto[name].$$stub &&
          ancestor !== from) {
        break;
      }

      if (ancestor === from) {
        target.prototype[name] = body
        break;
      }
    }

  };

  // Bridges from *donator* to a *target*.
  Opal._bridge = function(target, donator) {
    var id, methods, method, i, bridged;

    if (typeof(target) === "function") {
      id      = donator.$__id__();
      methods = donator.$instance_methods();

      for (i = methods.length - 1; i >= 0; i--) {
        method = '$' + methods[i];

        Opal.bridge_method(target, donator, method, donator.$$proto[method]);
      }

      if (!bridges[id]) {
        bridges[id] = [];
      }

      bridges[id].push(target);
    }
    else {
      bridged = bridges[target.$__id__()];

      if (bridged) {
        for (i = bridged.length - 1; i >= 0; i--) {
          Opal._bridge(bridged[i], donator);
        }

        bridges[donator.$__id__()] = bridged.slice();
      }
    }
  };

  // The actual inclusion of a module into a class.
  //
  // ## Class `$$parent` and `iclass`
  //
  // To handle `super` calls, every class has a `$$parent`. This parent is
  // used to resolve the next class for a super call. A normal class would
  // have this point to its superclass. However, if a class includes a module
  // then this would need to take into account the module. The module would
  // also have to then point its `$$parent` to the actual superclass. We
  // cannot modify modules like this, because it might be included in more
  // then one class. To fix this, we actually insert an `iclass` as the class'
  // `$$parent` which can then point to the superclass. The `iclass` acts as
  // a proxy to the actual module, so the `super` chain can then search it for
  // the required method.
  //
  // @param module [Module] the module to include
  // @param klass  [Class] the target class to include module into
  // @return [null]
  Opal.append_features = function(module, klass) {
    var iclass, donator, prototype, methods, id, i;

    // check if this module is already included in the class
    for (i = klass.$$inc.length - 1; i >= 0; i--) {
      if (klass.$$inc[i] === module) {
        return;
      }
    }

    klass.$$inc.push(module);
    module.$$dep.push(klass);
    Opal._bridge(klass, module);

    // iclass
    iclass = {
      $$name:   module.$$name,
      $$proto:  module.$$proto,
      $$parent: klass.$$parent,
      $$module: module,
      $$iclass: true
    };

    klass.$$parent = iclass;

    donator   = module.$$proto;
    prototype = klass.$$proto;
    methods   = module.$instance_methods();

    for (i = methods.length - 1; i >= 0; i--) {
      id = '$' + methods[i];

      // if the target class already has a method of the same name defined
      // and that method was NOT donated, then it must be a method defined
      // by the class so we do not want to override it
      if ( prototype.hasOwnProperty(id) &&
          !prototype[id].$$donated &&
          !prototype[id].$$stub) {
        continue;
      }

      prototype[id] = donator[id];
      prototype[id].$$donated = module;
    }

    Opal.donate_constants(module, klass);
  };

  // Table that holds all methods that have been defined on all objects
  // It is used for defining method stubs for new coming native classes
  Opal.stubs = {};

  // For performance, some core Ruby classes are toll-free bridged to their
  // native JavaScript counterparts (e.g. a Ruby Array is a JavaScript Array).
  //
  // This method is used to setup a native constructor (e.g. Array), to have
  // its prototype act like a normal Ruby class. Firstly, a new Ruby class is
  // created using the native constructor so that its prototype is set as the
  // target for th new class. Note: all bridged classes are set to inherit
  // from Object.
  //
  // Example:
  //
  //    Opal.bridge(self, Function);
  //
  // @param klass       [Class] the Ruby class to bridge
  // @param constructor [JS.Function] native JavaScript constructor to use
  // @return [Class] returns the passed Ruby class
  //
  Opal.bridge = function(klass, constructor) {
    if (constructor.$$bridge) {
      throw Opal.ArgumentError.$new("already bridged");
    }

    Opal.stub_subscribers.push(constructor.prototype);

    // Populate constructor with previously stored stubs
    for (var method_name in Opal.stubs) {
      if (!(method_name in constructor.prototype)) {
        constructor.prototype[method_name] = Opal.stub_for(method_name);
      }
    }

    constructor.prototype.$$class = klass;
    constructor.$$bridge          = klass;

    var ancestors = klass.$ancestors();

    // order important here, we have to bridge from the last ancestor to the
    // bridged class
    for (var i = ancestors.length - 1; i >= 0; i--) {
      Opal._bridge(constructor, ancestors[i]);
    }

    for (var name in BasicObject_alloc.prototype) {
      var method = BasicObject_alloc.prototype[method];

      if (method && method.$$stub && !(name in constructor.prototype)) {
        constructor.prototype[name] = method;
      }
    }

    return klass;
  };

  // When a source module is included into the target module, we must also copy
  // its constants to the target.
  //
  Opal.donate_constants = function(source_mod, target_mod) {
    var source_constants = source_mod.$$scope.constants,
        target_scope     = target_mod.$$scope,
        target_constants = target_scope.constants;

    for (var i = 0, length = source_constants.length; i < length; i++) {
      target_constants.push(source_constants[i]);
      target_scope[source_constants[i]] = source_mod.$$scope[source_constants[i]];
    }
  };

  // Donate methods for a module.
  Opal.donate = function(module, jsid) {
    var included_in = module.$$dep,
        body = module.$$proto[jsid],
        i, length, includee, dest, current,
        klass_includees, j, jj, current_owner_index, module_index;

    if (!included_in) {
      return;
    }

    for (i = 0, length = included_in.length; i < length; i++) {
      includee = included_in[i];
      dest = includee.$$proto;
      current = dest[jsid];

      if (dest.hasOwnProperty(jsid) && !current.$$donated && !current.$$stub) {
        // target class has already defined the same method name - do nothing
      }
      else if (dest.hasOwnProperty(jsid) && !current.$$stub) {
        // target class includes another module that has defined this method
        klass_includees = includee.$$inc;

        for (j = 0, jj = klass_includees.length; j < jj; j++) {
          if (klass_includees[j] === current.$$donated) {
            current_owner_index = j;
          }
          if (klass_includees[j] === module) {
            module_index = j;
          }
        }

        // only redefine method on class if the module was included AFTER
        // the module which defined the current method body. Also make sure
        // a module can overwrite a method it defined before
        if (current_owner_index <= module_index) {
          dest[jsid] = body;
          dest[jsid].$$donated = module;
        }
      }
      else {
        // neither a class, or module included by class, has defined method
        dest[jsid] = body;
        dest[jsid].$$donated = module;
      }

      if (includee.$$dep) {
        Opal.donate(includee, jsid);
      }
    }
  };

  // The Array of ancestors for a given module/class
  Opal.ancestors = function(module_or_class) {
    var parent = module_or_class,
        result = [],
        modules;

    while (parent) {
      result.push(parent);
      for (var i=0; i < parent.$$inc.length; i++) {
        modules = Opal.ancestors(parent.$$inc[i]);

        for(var j = 0; j < modules.length; j++) {
          result.push(modules[j]);
        }
      }

      // only the actual singleton class gets included in its ancestry
      // after that, traverse the normal class hierarchy
      if (parent.$$is_singleton && parent.$$singleton_of.$$is_module) {
        parent = parent.$$singleton_of.$$super;
      }
      else {
        parent = parent.$$is_class ? parent.$$super : null;
      }
    }

    return result;
  };


  // Method Missing
  // --------------

  // Methods stubs are used to facilitate method_missing in opal. A stub is a
  // placeholder function which just calls `method_missing` on the receiver.
  // If no method with the given name is actually defined on an object, then it
  // is obvious to say that the stub will be called instead, and then in turn
  // method_missing will be called.
  //
  // When a file in ruby gets compiled to javascript, it includes a call to
  // this function which adds stubs for every method name in the compiled file.
  // It should then be safe to assume that method_missing will work for any
  // method call detected.
  //
  // Method stubs are added to the BasicObject prototype, which every other
  // ruby object inherits, so all objects should handle method missing. A stub
  // is only added if the given property name (method name) is not already
  // defined.
  //
  // Note: all ruby methods have a `$` prefix in javascript, so all stubs will
  // have this prefix as well (to make this method more performant).
  //
  //    Opal.add_stubs(["$foo", "$bar", "$baz="]);
  //
  // All stub functions will have a private `$$stub` property set to true so
  // that other internal methods can detect if a method is just a stub or not.
  // `Kernel#respond_to?` uses this property to detect a methods presence.
  //
  // @param stubs [Array] an array of method stubs to add
  // @return [undefined]
  Opal.add_stubs = function(stubs) {
    var subscriber, subscribers = Opal.stub_subscribers,
        i, ilength = stubs.length,
        j, jlength = subscribers.length,
        method_name, stub;

    for (i = 0; i < ilength; i++) {
      method_name = stubs[i];
      // Save method name to populate other subscribers with this stub
      Opal.stubs[method_name] = true;
      stub = Opal.stub_for(method_name);

      for (j = 0; j < jlength; j++) {
        subscriber = subscribers[j];

        if (!(method_name in subscriber)) {
          subscriber[method_name] = stub;
        }
      }
    }
  };

  // Keep a list of prototypes that want method_missing stubs to be added.
  //
  // @default [Prototype List] BasicObject_alloc.prototype
  //
  Opal.stub_subscribers = [BasicObject_alloc.prototype];

  // Add a method_missing stub function to the given prototype for the
  // given name.
  //
  // @param prototype [Prototype] the target prototype
  // @param stub [String] stub name to add (e.g. "$foo")
  // @return [undefined]
  Opal.add_stub_for = function(prototype, stub) {
    var method_missing_stub = Opal.stub_for(stub);
    prototype[stub] = method_missing_stub;
  };

  // Generate the method_missing stub for a given method name.
  //
  // @param method_name [String] The js-name of the method to stub (e.g. "$foo")
  // @return [undefined]
  Opal.stub_for = function(method_name) {
    function method_missing_stub() {
      // Copy any given block onto the method_missing dispatcher
      this.$method_missing.$$p = method_missing_stub.$$p;

      // Set block property to null ready for the next call (stop false-positives)
      method_missing_stub.$$p = null;

      // call method missing with correct args (remove '$' prefix on method name)
      var args_ary = new Array(arguments.length);
      for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = arguments[i]; }

      return this.$method_missing.apply(this, [method_name.slice(1)].concat(args_ary));
    }

    method_missing_stub.$$stub = true;

    return method_missing_stub;
  };


  // Methods
  // -------

  // Arity count error dispatcher for methods
  //
  // @param actual [Fixnum] number of arguments given to method
  // @param expected [Fixnum] expected number of arguments
  // @param object [Object] owner of the method +meth+
  // @param meth [String] method name that got wrong number of arguments
  // @raise [ArgumentError]
  Opal.ac = function(actual, expected, object, meth) {
    var inspect = '';
    if (object.$$is_class || object.$$is_module) {
      inspect += object.$$name + '.';
    }
    else {
      inspect += object.$$class.$$name + '#';
    }
    inspect += meth;

    throw Opal.ArgumentError.$new('[' + inspect + '] wrong number of arguments(' + actual + ' for ' + expected + ')');
  };

  // Arity count error dispatcher for blocks
  //
  // @param actual [Fixnum] number of arguments given to block
  // @param expected [Fixnum] expected number of arguments
  // @param context [Object] context of the block definition
  // @raise [ArgumentError]
  Opal.block_ac = function(actual, expected, context) {
    var inspect = "`block in " + context + "'";

    throw Opal.ArgumentError.$new(inspect + ': wrong number of arguments (' + actual + ' for ' + expected + ')');
  }

  // Super dispatcher
  Opal.find_super_dispatcher = function(obj, jsid, current_func, defcheck, defs) {
    var dispatcher;

    if (defs) {
      if (obj.$$is_class || obj.$$is_module) {
        dispatcher = defs.$$super;
      }
      else {
        dispatcher = obj.$$class.$$proto;
      }
    }
    else {
      dispatcher = Opal.find_obj_super_dispatcher(obj, jsid, current_func);
    }

    dispatcher = dispatcher['$' + jsid];

    if (!defcheck && dispatcher.$$stub && Opal.Kernel.$method_missing === obj.$method_missing) {
      // method_missing hasn't been explicitly defined
      throw Opal.NoMethodError.$new('super: no superclass method `'+jsid+"' for "+obj, jsid);
    }

    return dispatcher;
  };

  // Iter dispatcher for super in a block
  Opal.find_iter_super_dispatcher = function(obj, jsid, current_func, defcheck, implicit) {
    var call_jsid = jsid;

    if (!current_func) {
      throw Opal.RuntimeError.$new("super called outside of method");
    }

    if (implicit && current_func.$$define_meth) {
      throw Opal.RuntimeError.$new("implicit argument passing of super from method defined by define_method() is not supported. Specify all arguments explicitly");
    }

    if (current_func.$$def) {
      call_jsid = current_func.$$jsid;
    }

    return Opal.find_super_dispatcher(obj, call_jsid, current_func, defcheck);
  };

  Opal.find_obj_super_dispatcher = function(obj, jsid, current_func) {
    var klass = obj.$$meta || obj.$$class;

    // first we need to find the class/module current_func is located on
    klass = Opal.find_owning_class(klass, current_func);

    if (!klass) {
      throw new Error("could not find current class for super()");
    }

    jsid = '$' + jsid;
    return Opal.find_super_func(klass, jsid, current_func);
  };

  Opal.find_owning_class = function(klass, current_func) {
    var owner = current_func.$$owner;

    while (klass) {
      // repeating for readability

      if (klass.$$iclass && klass.$$module === current_func.$$donated) {
        // this klass was the last one the module donated to
        // case is also hit with multiple module includes
        break;
      }
      else if (klass.$$iclass && klass.$$module === owner) {
        // module has donated to other classes but klass isn't one of those
        break;
      }
      else if (owner.$$is_singleton && klass === owner.$$singleton_of.$$class) {
        // cases like stdlib `Singleton::included` that use a singleton of a singleton
        break;
      }
      else if (klass === owner) {
        // no modules, pure class inheritance
        break;
      }

      klass = klass.$$parent;
    }

    return klass;
  };

  Opal.find_super_func = function(owning_klass, jsid, current_func) {
    var klass = owning_klass.$$parent;

    // now we can find the super
    while (klass) {
      var working = klass.$$proto[jsid];

      if (working && working !== current_func) {
        // ok
        break;
      }

      klass = klass.$$parent;
    }

    return klass.$$proto;
  };

  // Used to return as an expression. Sometimes, we can't simply return from
  // a javascript function as if we were a method, as the return is used as
  // an expression, or even inside a block which must "return" to the outer
  // method. This helper simply throws an error which is then caught by the
  // method. This approach is expensive, so it is only used when absolutely
  // needed.
  //
  Opal.ret = function(val) {
    Opal.returner.$v = val;
    throw Opal.returner;
  };

  // Used to break out of a block.
  Opal.brk = function(val, breaker) {
    breaker.$v = val;
    throw breaker;
  };

  // Builds a new unique breaker, this is to avoid multiple nested breaks to get
  // in the way of each other.
  Opal.new_brk = function() {
    return new Error('unexpected break');
  };

  // handles yield calls for 1 yielded arg
  Opal.yield1 = function(block, arg) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    var has_mlhs = block.$$has_top_level_mlhs_arg,
        has_trailing_comma = block.$$has_trailing_comma_in_args;

    if (block.length > 1 || ((has_mlhs || has_trailing_comma) && block.length === 1)) {
      arg = Opal.to_ary(arg);
    }

    if ((block.length > 1 || (has_trailing_comma && block.length === 1)) && arg.$$is_array) {
      return block.apply(null, arg);
    }
    else {
      return block(arg);
    }
  };

  // handles yield for > 1 yielded arg
  Opal.yieldX = function(block, args) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && args.length === 1) {
      if (args[0].$$is_array) {
        return block.apply(null, args[0]);
      }
    }

    if (!args.$$is_array) {
      var args_ary = new Array(args.length);
      for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = args[i]; }

      return block.apply(null, args_ary);
    }

    return block.apply(null, args);
  };

  // Finds the corresponding exception match in candidates.  Each candidate can
  // be a value, or an array of values.  Returns null if not found.
  Opal.rescue = function(exception, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];

      if (candidate.$$is_array) {
        var result = Opal.rescue(exception, candidate);

        if (result) {
          return result;
        }
      }
      else if (candidate['$==='](exception)) {
        return candidate;
      }
    }

    return null;
  };

  Opal.is_a = function(object, klass) {
    if (object.$$meta === klass) {
      return true;
    }

    var i, length, ancestors = Opal.ancestors(object.$$class);

    for (i = 0, length = ancestors.length; i < length; i++) {
      if (ancestors[i] === klass) {
        return true;
      }
    }

    ancestors = Opal.ancestors(object.$$meta);

    for (i = 0, length = ancestors.length; i < length; i++) {
      if (ancestors[i] === klass) {
        return true;
      }
    }

    return false;
  };

  // Helpers for extracting kwsplats
  // Used for: { **h }
  Opal.to_hash = function(value) {
    if (value.$$is_hash) {
      return value;
    }
    else if (value['$respond_to?']('to_hash', true)) {
      var hash = value.$to_hash();
      if (hash.$$is_hash) {
        return hash;
      }
      else {
        throw Opal.TypeError.$new("Can't convert " + value.$$class +
          " to Hash (" + value.$$class + "#to_hash gives " + hash.$$class + ")");
      }
    }
    else {
      throw Opal.TypeError.$new("no implicit conversion of " + value.$$class + " into Hash");
    }
  };

  // Helpers for implementing multiple assignment
  // Our code for extracting the values and assigning them only works if the
  // return value is a JS array.
  // So if we get an Array subclass, extract the wrapped JS array from it

  // Used for: a, b = something (no splat)
  Opal.to_ary = function(value) {
    if (value.$$is_array) {
      return value;
    }
    else if (value['$respond_to?']('to_ary', true)) {
      var ary = value.$to_ary();
      if (ary === nil) {
        return [value];
      }
      else if (ary.$$is_array) {
        return ary;
      }
      else {
        throw Opal.TypeError.$new("Can't convert " + value.$$class +
          " to Array (" + value.$$class + "#to_ary gives " + ary.$$class + ")");
      }
    }
    else {
      return [value];
    }
  };

  // Used for: a, b = *something (with splat)
  Opal.to_a = function(value) {
    if (value.$$is_array) {
      // A splatted array must be copied
      return value.slice();
    }
    else if (value['$respond_to?']('to_a', true)) {
      var ary = value.$to_a();
      if (ary === nil) {
        return [value];
      }
      else if (ary.$$is_array) {
        return ary;
      }
      else {
        throw Opal.TypeError.$new("Can't convert " + value.$$class +
          " to Array (" + value.$$class + "#to_a gives " + ary.$$class + ")");
      }
    }
    else {
      return [value];
    }
  };

  // Used for extracting keyword arguments from arguments passed to
  // JS function. If provided +arguments+ list doesn't have a Hash
  // as a last item, returns a blank Hash.
  //
  // @param parameters [Array]
  // @return [Hash]
  //
  Opal.extract_kwargs = function(parameters) {
    var kwargs = parameters[parameters.length - 1];
    if (kwargs != null && kwargs['$respond_to?']('to_hash', true)) {
      Array.prototype.splice.call(parameters, parameters.length - 1, 1);
      return kwargs.$to_hash();
    }
    else {
      return Opal.hash2([], {});
    }
  }

  // Used to get a list of rest keyword arguments. Method takes the given
  // keyword args, i.e. the hash literal passed to the method containing all
  // keyword arguemnts passed to method, as well as the used args which are
  // the names of required and optional arguments defined. This method then
  // just returns all key/value pairs which have not been used, in a new
  // hash literal.
  //
  // @param given_args [Hash] all kwargs given to method
  // @param used_args [Object<String: true>] all keys used as named kwargs
  // @return [Hash]
  //
  Opal.kwrestargs = function(given_args, used_args) {
    var keys      = [],
        map       = {},
        key       = null,
        given_map = given_args.$$smap;

    for (key in given_map) {
      if (!used_args[key]) {
        keys.push(key);
        map[key] = given_map[key];
      }
    }

    return Opal.hash2(keys, map);
  };

  // Call a ruby method on a ruby object with some arguments:
  //
  // @example
  //   var my_array = [1, 2, 3, 4]
  //   Opal.send(my_array, 'length')     # => 4
  //   Opal.send(my_array, 'reverse!')   # => [4, 3, 2, 1]
  //
  // A missing method will be forwarded to the object via
  // method_missing.
  //
  // The result of either call with be returned.
  //
  // @param recv [Object] the ruby object
  // @param mid  [String] ruby method to call
  // @return [Object] forwards the return value of the method (or of method_missing)
  Opal.send = function(recv, mid) {
    var args_ary = new Array(Math.max(arguments.length - 2, 0));
    for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = arguments[i + 2]; }

    var func = recv['$' + mid];

    if (func) {
      return func.apply(recv, args_ary);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args_ary));
  };

  Opal.block_send = function(recv, mid, block) {
    var args_ary = new Array(Math.max(arguments.length - 3, 0));
    for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = arguments[i + 3]; }

    var func = recv['$' + mid];

    if (func) {
      func.$$p = block;
      return func.apply(recv, args_ary);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args_ary));
  };

  // Used to define methods on an object. This is a helper method, used by the
  // compiled source to define methods on special case objects when the compiler
  // can not determine the destination object, or the object is a Module
  // instance. This can get called by `Module#define_method` as well.
  //
  // ## Modules
  //
  // Any method defined on a module will come through this runtime helper.
  // The method is added to the module body, and the owner of the method is
  // set to be the module itself. This is used later when choosing which
  // method should show on a class if more than 1 included modules define
  // the same method. Finally, if the module is in `module_function` mode,
  // then the method is also defined onto the module itself.
  //
  // ## Classes
  //
  // This helper will only be called for classes when a method is being
  // defined indirectly; either through `Module#define_method`, or by a
  // literal `def` method inside an `instance_eval` or `class_eval` body. In
  // either case, the method is simply added to the class' prototype. A special
  // exception exists for `BasicObject` and `Object`. These two classes are
  // special because they are used in toll-free bridged classes. In each of
  // these two cases, extra work is required to define the methods on toll-free
  // bridged class' prototypes as well.
  //
  // ## Objects
  //
  // If a simple ruby object is the object, then the method is simply just
  // defined on the object as a singleton method. This would be the case when
  // a method is defined inside an `instance_eval` block.
  //
  // @param obj  [Object, Class] the actual obj to define method for
  // @param jsid [String] the JavaScript friendly method name (e.g. '$foo')
  // @param body [JS.Function] the literal JavaScript function used as method
  // @return [null]
  //
  Opal.defn = function(obj, jsid, body) {
    obj.$$proto[jsid] = body;
    // for super dispatcher, etc.
    body.$$owner = obj;

    if (obj.$$is_module) {
      Opal.donate(obj, jsid);

      if (obj.$$module_function) {
        Opal.defs(obj, jsid, body);
      }
    }

    if (obj.$__id__ && !obj.$__id__.$$stub) {
      var bridged = bridges[obj.$__id__()];

      if (bridged) {
        for (var i = bridged.length - 1; i >= 0; i--) {
          Opal.bridge_method(bridged[i], obj, jsid, body);
        }
      }
    }

    var singleton_of = obj.$$singleton_of;
    if (obj.$method_added && !obj.$method_added.$$stub && !singleton_of) {
      obj.$method_added(jsid.substr(1));
    }
    else if (singleton_of && singleton_of.$singleton_method_added && !singleton_of.$singleton_method_added.$$stub) {
      singleton_of.$singleton_method_added(jsid.substr(1));
    }

    return nil;
  };

  // Define a singleton method on the given object.
  Opal.defs = function(obj, jsid, body) {
    Opal.defn(Opal.get_singleton_class(obj), jsid, body)
  };

  Opal.def = function(obj, jsid, body) {
    // if instance_eval is invoked on a module/class, it sets inst_eval_mod
    if (!obj.$$eval && (obj.$$is_class || obj.$$is_module)) {
      Opal.defn(obj, jsid, body);
    }
    else {
      Opal.defs(obj, jsid, body);
    }
  };

  // Called from #remove_method.
  Opal.rdef = function(obj, jsid) {
    // TODO: remove from bridges as well

    if (!$hasOwn.call(obj.$$proto, jsid)) {
      throw Opal.NameError.$new("method '" + jsid.substr(1) + "' not defined in " + obj.$name());
    }

    delete obj.$$proto[jsid];

    if (obj.$$is_singleton) {
      if (obj.$$proto.$singleton_method_removed && !obj.$$proto.$singleton_method_removed.$$stub) {
        obj.$$proto.$singleton_method_removed(jsid.substr(1));
      }
    }
    else {
      if (obj.$method_removed && !obj.$method_removed.$$stub) {
        obj.$method_removed(jsid.substr(1));
      }
    }
  };

  // Called from #undef_method.
  Opal.udef = function(obj, jsid) {
    if (!obj.$$proto[jsid] || obj.$$proto[jsid].$$stub) {
      throw Opal.NameError.$new("method '" + jsid.substr(1) + "' not defined in " + obj.$name());
    }

    Opal.add_stub_for(obj.$$proto, jsid);

    if (obj.$$is_singleton) {
      if (obj.$$proto.$singleton_method_undefined && !obj.$$proto.$singleton_method_undefined.$$stub) {
        obj.$$proto.$singleton_method_undefined(jsid.substr(1));
      }
    }
    else {
      if (obj.$method_undefined && !obj.$method_undefined.$$stub) {
        obj.$method_undefined(jsid.substr(1));
      }
    }
  };

  Opal.alias = function(obj, name, old) {
    var id     = '$' + name,
        old_id = '$' + old,
        body   = obj.$$proto['$' + old];

    // instance_eval is being run on a class/module, so that need to alias class methods
    if (obj.$$eval) {
      return Opal.alias(Opal.get_singleton_class(obj), name, old);
    }

    if (typeof(body) !== "function" || body.$$stub) {
      var ancestor = obj.$$super;

      while (typeof(body) !== "function" && ancestor) {
        body     = ancestor[old_id];
        ancestor = ancestor.$$super;
      }

      if (typeof(body) !== "function" || body.$$stub) {
        throw Opal.NameError.$new("undefined method `" + old + "' for class `" + obj.$name() + "'")
      }
    }

    Opal.defn(obj, id, body);

    return obj;
  };

  Opal.alias_native = function(obj, name, native_name) {
    var id   = '$' + name,
        body = obj.$$proto[native_name];

    if (typeof(body) !== "function" || body.$$stub) {
      throw Opal.NameError.$new("undefined native method `" + native_name + "' for class `" + obj.$name() + "'")
    }

    Opal.defn(obj, id, body);

    return obj;
  };


  // Hashes
  // ------

  Opal.hash_init = function(hash) {
    hash.$$smap = {};
    hash.$$map  = {};
    hash.$$keys = [];
  };

  Opal.hash_clone = function(from_hash, to_hash) {
    to_hash.$$none = from_hash.$$none;
    to_hash.$$proc = from_hash.$$proc;

    for (var i = 0, keys = from_hash.$$keys, length = keys.length, key, value; i < length; i++) {
      key = from_hash.$$keys[i];

      if (key.$$is_string) {
        value = from_hash.$$smap[key];
      } else {
        value = key.value;
        key = key.key;
      }

      Opal.hash_put(to_hash, key, value);
    }
  };

  Opal.hash_put = function(hash, key, value) {
    if (key.$$is_string) {
      if (!hash.$$smap.hasOwnProperty(key)) {
        hash.$$keys.push(key);
      }
      hash.$$smap[key] = value;
      return;
    }

    var key_hash = key.$hash(), bucket, last_bucket;

    if (!hash.$$map.hasOwnProperty(key_hash)) {
      bucket = {key: key, key_hash: key_hash, value: value};
      hash.$$keys.push(bucket);
      hash.$$map[key_hash] = bucket;
      return;
    }

    bucket = hash.$$map[key_hash];

    while (bucket) {
      if (key === bucket.key || key['$eql?'](bucket.key)) {
        last_bucket = undefined;
        bucket.value = value;
        break;
      }
      last_bucket = bucket;
      bucket = bucket.next;
    }

    if (last_bucket) {
      bucket = {key: key, key_hash: key_hash, value: value};
      hash.$$keys.push(bucket);
      last_bucket.next = bucket;
    }
  };

  Opal.hash_get = function(hash, key) {
    if (key.$$is_string) {
      if (hash.$$smap.hasOwnProperty(key)) {
        return hash.$$smap[key];
      }
      return;
    }

    var key_hash = key.$hash(), bucket;

    if (hash.$$map.hasOwnProperty(key_hash)) {
      bucket = hash.$$map[key_hash];

      while (bucket) {
        if (key === bucket.key || key['$eql?'](bucket.key)) {
          return bucket.value;
        }
        bucket = bucket.next;
      }
    }
  };

  Opal.hash_delete = function(hash, key) {
    var i, keys = hash.$$keys, length = keys.length, value;

    if (key.$$is_string) {
      if (!hash.$$smap.hasOwnProperty(key)) {
        return;
      }

      for (i = 0; i < length; i++) {
        if (keys[i] === key) {
          keys.splice(i, 1);
          break;
        }
      }

      value = hash.$$smap[key];
      delete hash.$$smap[key];
      return value;
    }

    var key_hash = key.$hash();

    if (!hash.$$map.hasOwnProperty(key_hash)) {
      return;
    }

    var bucket = hash.$$map[key_hash], last_bucket;

    while (bucket) {
      if (key === bucket.key || key['$eql?'](bucket.key)) {
        value = bucket.value;

        for (i = 0; i < length; i++) {
          if (keys[i] === bucket) {
            keys.splice(i, 1);
            break;
          }
        }

        if (last_bucket && bucket.next) {
          last_bucket.next = bucket.next;
        }
        else if (last_bucket) {
          delete last_bucket.next;
        }
        else if (bucket.next) {
          hash.$$map[key_hash] = bucket.next;
        }
        else {
          delete hash.$$map[key_hash];
        }

        return value;
      }
      last_bucket = bucket;
      bucket = bucket.next;
    }
  };

  Opal.hash_rehash = function(hash) {
    for (var i = 0, length = hash.$$keys.length, key_hash, bucket, last_bucket; i < length; i++) {

      if (hash.$$keys[i].$$is_string) {
        continue;
      }

      key_hash = hash.$$keys[i].key.$hash();

      if (key_hash === hash.$$keys[i].key_hash) {
        continue;
      }

      bucket = hash.$$map[hash.$$keys[i].key_hash];
      last_bucket = undefined;

      while (bucket) {
        if (bucket === hash.$$keys[i]) {
          if (last_bucket && bucket.next) {
            last_bucket.next = bucket.next;
          }
          else if (last_bucket) {
            delete last_bucket.next;
          }
          else if (bucket.next) {
            hash.$$map[hash.$$keys[i].key_hash] = bucket.next;
          }
          else {
            delete hash.$$map[hash.$$keys[i].key_hash];
          }
          break;
        }
        last_bucket = bucket;
        bucket = bucket.next;
      }

      hash.$$keys[i].key_hash = key_hash;

      if (!hash.$$map.hasOwnProperty(key_hash)) {
        hash.$$map[key_hash] = hash.$$keys[i];
        continue;
      }

      bucket = hash.$$map[key_hash];
      last_bucket = undefined;

      while (bucket) {
        if (bucket === hash.$$keys[i]) {
          last_bucket = undefined;
          break;
        }
        last_bucket = bucket;
        bucket = bucket.next;
      }

      if (last_bucket) {
        last_bucket.next = hash.$$keys[i];
      }
    }
  };

  Opal.hash = function() {
    var arguments_length = arguments.length, args, hash, i, length, key, value;

    if (arguments_length === 1 && arguments[0].$$is_hash) {
      return arguments[0];
    }

    hash = new Opal.Hash.$$alloc();
    Opal.hash_init(hash);

    if (arguments_length === 1 && arguments[0].$$is_array) {
      args = arguments[0];
      length = args.length;

      for (i = 0; i < length; i++) {
        if (args[i].length !== 2) {
          throw Opal.ArgumentError.$new("value not of length 2: " + args[i].$inspect());
        }

        key = args[i][0];
        value = args[i][1];

        Opal.hash_put(hash, key, value);
      }

      return hash;
    }

    if (arguments_length === 1) {
      args = arguments[0];
      for (key in args) {
        if (args.hasOwnProperty(key)) {
          value = args[key];

          Opal.hash_put(hash, key, value);
        }
      }

      return hash;
    }

    if (arguments_length % 2 !== 0) {
      throw Opal.ArgumentError.$new("odd number of arguments for Hash");
    }

    for (i = 0; i < arguments_length; i += 2) {
      key = arguments[i];
      value = arguments[i + 1];

      Opal.hash_put(hash, key, value);
    }

    return hash;
  };

  // hash2 is a faster creator for hashes that just use symbols and
  // strings as keys. The map and keys array can be constructed at
  // compile time, so they are just added here by the constructor
  // function
  //
  Opal.hash2 = function(keys, smap) {
    var hash = new Opal.Hash.$$alloc();

    hash.$$smap = smap;
    hash.$$map  = {};
    hash.$$keys = keys;

    return hash;
  };

  // Create a new range instance with first and last values, and whether the
  // range excludes the last value.
  //
  Opal.range = function(first, last, exc) {
    var range         = new Opal.Range.$$alloc();
        range.begin   = first;
        range.end     = last;
        range.exclude = exc;

    return range;
  };

  Opal.ivar = function(name) {
    if (
        // properties
        name === "constructor" ||
        name === "displayName" ||
        name === "__count__" ||
        name === "__noSuchMethod__" ||
        name === "__parent__" ||
        name === "__proto__" ||

        // methods
        name === "hasOwnProperty" ||
        name === "valueOf"
       )
    {
      return name + "$";
    }

    return name;
  };


  // Require system
  // --------------

  Opal.modules         = {};
  Opal.loaded_features = ['corelib/runtime'];
  Opal.current_dir     = '.'
  Opal.require_table   = {'corelib/runtime': true};

  Opal.normalize = function(path) {
    var parts, part, new_parts = [], SEPARATOR = '/';

    if (Opal.current_dir !== '.') {
      path = Opal.current_dir.replace(/\/*$/, '/') + path;
    }

    path = path.replace(/\.(rb|opal|js)$/, '');
    parts = path.split(SEPARATOR);

    for (var i = 0, ii = parts.length; i < ii; i++) {
      part = parts[i];
      if (part === '') continue;
      (part === '..') ? new_parts.pop() : new_parts.push(part)
    }

    return new_parts.join(SEPARATOR);
  };

  Opal.loaded = function(paths) {
    var i, l, path;

    for (i = 0, l = paths.length; i < l; i++) {
      path = Opal.normalize(paths[i]);

      if (Opal.require_table[path]) {
        return;
      }

      Opal.loaded_features.push(path);
      Opal.require_table[path] = true;
    }
  };

  Opal.load = function(path) {
    path = Opal.normalize(path);

    Opal.loaded([path]);

    var module = Opal.modules[path];

    if (module) {
      module(Opal);
    }
    else {
      var severity = Opal.config.missing_require_severity;
      var message  = 'cannot load such file -- ' + path;

      if (severity === "error") {
        Opal.LoadError ? Opal.LoadError.$new(message) : function(){throw message}();
      }
      else if (severity === "warning") {
        console.warn('WARNING: LoadError: ' + message);
      }
    }

    return true;
  };

  Opal.require = function(path) {
    path = Opal.normalize(path);

    if (Opal.require_table[path]) {
      return false;
    }

    return Opal.load(path);
  };


  // Initialization
  // --------------

  // Constructors for *instances* of core objects
  Opal.boot_class_alloc('BasicObject', BasicObject_alloc);
  Opal.boot_class_alloc('Object',      Object_alloc,       BasicObject_alloc);
  Opal.boot_class_alloc('Module',      Module_alloc,       Object_alloc);
  Opal.boot_class_alloc('Class',       Class_alloc,        Module_alloc);

  // Constructors for *classes* of core objects
  Opal.BasicObject = BasicObject = Opal.setup_class_object('BasicObject', BasicObject_alloc, 'Class',       Class_alloc);
  Opal.Object      = _Object     = Opal.setup_class_object('Object',      Object_alloc,      'BasicObject', BasicObject.constructor);
  Opal.Module      = Module      = Opal.setup_class_object('Module',      Module_alloc,      'Object',      _Object.constructor);
  Opal.Class       = Class       = Opal.setup_class_object('Class',       Class_alloc,       'Module',      Module.constructor);

  Opal.constants.push("BasicObject");
  Opal.constants.push("Object");
  Opal.constants.push("Module");
  Opal.constants.push("Class");

  // Fix booted classes to use their metaclass
  BasicObject.$$class = Class;
  _Object.$$class     = Class;
  Module.$$class      = Class;
  Class.$$class       = Class;

  // Fix superclasses of booted classes
  BasicObject.$$super = null;
  _Object.$$super     = BasicObject;
  Module.$$super      = _Object;
  Class.$$super       = Module;

  BasicObject.$$parent = null;
  _Object.$$parent     = BasicObject;
  Module.$$parent      = _Object;
  Class.$$parent       = Module;

  Opal.base                = _Object;
  BasicObject.$$scope      = _Object.$$scope = Opal;
  BasicObject.$$orig_scope = _Object.$$orig_scope = Opal;

  Module.$$scope      = _Object.$$scope;
  Module.$$orig_scope = _Object.$$orig_scope;
  Class.$$scope       = _Object.$$scope;
  Class.$$orig_scope  = _Object.$$orig_scope;

  // Forward .toString() to #to_s
  _Object.$$proto.toString = function() {
    return this.$to_s();
  };

  // Make Kernel#require immediately available as it's needed to require all the
  // other corelib files.
  _Object.$$proto.$require = Opal.require;

  // Instantiate the top object
  Opal.top = new _Object.$$alloc();

  // Nil
  Opal.klass(_Object, _Object, 'NilClass', NilClass_alloc);
  nil = Opal.nil = new NilClass_alloc();
  nil.$$id = nil_id;
  nil.call = nil.apply = function() { throw Opal.LocalJumpError.$new('no block given'); };
  Opal.breaker  = new Error('unexpected break (old)');
  Opal.returner = new Error('unexpected return');

  TypeError.$$super = Error;
}).call(this);

if (typeof(global) !== 'undefined') {
  global.Opal = this.Opal;
  Opal.global = global;
}

if (typeof(window) !== 'undefined') {
  window.Opal = this.Opal;
  Opal.global = window;
}
Opal.loaded(["corelib/runtime"]);
/* Generated by Opal 0.10.3 */
Opal.modules["corelib/helpers"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$new', '$class', '$===', '$respond_to?', '$raise', '$type_error', '$__send__', '$coerce_to', '$nil?', '$<=>', '$inspect', '$coerce_to!', '$!=', '$[]', '$upcase']);
  return (function($base) {
    var $Opal, self = $Opal = $module($base, 'Opal');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13;

    Opal.defs(self, '$bridge', TMP_1 = function $$bridge(klass, constructor) {
      var self = this;

      return Opal.bridge(klass, constructor);
    }, TMP_1.$$arity = 2);

    Opal.defs(self, '$type_error', TMP_2 = function $$type_error(object, type, method, coerced) {
      var $a, $b, self = this;

      if (method == null) {
        method = nil;
      }
      if (coerced == null) {
        coerced = nil;
      }
      if ((($a = (($b = method !== false && method !== nil && method != null) ? coerced : method)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('TypeError').$new("can't convert " + (object.$class()) + " into " + (type) + " (" + (object.$class()) + "#" + (method) + " gives " + (coerced.$class()))
        } else {
        return $scope.get('TypeError').$new("no implicit conversion of " + (object.$class()) + " into " + (type))
      };
    }, TMP_2.$$arity = -3);

    Opal.defs(self, '$coerce_to', TMP_3 = function $$coerce_to(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type))
      };
      return object.$__send__(method);
    }, TMP_3.$$arity = 3);

    Opal.defs(self, '$coerce_to!', TMP_4 = function(object, type, method) {
      var $a, self = this, coerced = nil;

      coerced = self.$coerce_to(object, type, method);
      if ((($a = type['$==='](coerced)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    }, TMP_4.$$arity = 3);

    Opal.defs(self, '$coerce_to?', TMP_5 = function(object, type, method) {
      var $a, self = this, coerced = nil;

      if ((($a = object['$respond_to?'](method)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      coerced = self.$coerce_to(object, type, method);
      if ((($a = coerced['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if ((($a = type['$==='](coerced)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    }, TMP_5.$$arity = 3);

    Opal.defs(self, '$try_convert', TMP_6 = function $$try_convert(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return object.$__send__(method)
        } else {
        return nil
      };
    }, TMP_6.$$arity = 3);

    Opal.defs(self, '$compare', TMP_7 = function $$compare(a, b) {
      var $a, self = this, compare = nil;

      compare = a['$<=>'](b);
      if ((($a = compare === nil) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (a.$class()) + " with " + (b.$class()) + " failed")};
      return compare;
    }, TMP_7.$$arity = 2);

    Opal.defs(self, '$destructure', TMP_8 = function $$destructure(args) {
      var self = this;

      
      if (args.length == 1) {
        return args[0];
      }
      else if (args.$$is_array) {
        return args;
      }
      else {
        var args_ary = new Array(args.length);
        for(var i = 0, l = args_ary.length; i < l; i++) { args_ary[i] = args[i]; }

        return args_ary;
      }
    
    }, TMP_8.$$arity = 1);

    Opal.defs(self, '$respond_to?', TMP_9 = function(obj, method) {
      var self = this;

      
      if (obj == null || !obj.$$class) {
        return false;
      }
    
      return obj['$respond_to?'](method);
    }, TMP_9.$$arity = 2);

    Opal.defs(self, '$inspect', TMP_10 = function $$inspect(obj) {
      var self = this;

      
      if (obj === undefined) {
        return "undefined";
      }
      else if (obj === null) {
        return "null";
      }
      else if (!obj.$$class) {
        return obj.toString();
      }
      else {
        return obj.$inspect();
      }
    
    }, TMP_10.$$arity = 1);

    Opal.defs(self, '$instance_variable_name!', TMP_11 = function(name) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = /^@[a-zA-Z_][a-zA-Z0-9_]*?$/.test(name)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError').$new("'" + (name) + "' is not allowed as an instance variable name", name))
      };
      return name;
    }, TMP_11.$$arity = 1);

    Opal.defs(self, '$const_name!', TMP_12 = function(const_name) {
      var $a, self = this;

      const_name = $scope.get('Opal')['$coerce_to!'](const_name, $scope.get('String'), "to_str");
      if ((($a = const_name['$[]'](0)['$!='](const_name['$[]'](0).$upcase())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError'), "wrong constant name " + (const_name))};
      return const_name;
    }, TMP_12.$$arity = 1);

    Opal.defs(self, '$pristine', TMP_13 = function $$pristine(owner_class, $a_rest) {
      var self = this, method_names;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      method_names = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        method_names[$arg_idx - 1] = arguments[$arg_idx];
      }
      
      var method_name;
      for (var i = method_names.length - 1; i >= 0; i--) {
        method_name = method_names[i];
        owner_class.$$proto['$'+method_name].$$pristine = true
      }
    
      return nil;
    }, TMP_13.$$arity = -2);
  })($scope.base)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/module"] = function(Opal) {
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range, $hash2 = Opal.hash2;

  Opal.add_stubs(['$===', '$raise', '$equal?', '$<', '$>', '$nil?', '$attr_reader', '$attr_writer', '$coerce_to!', '$new', '$const_name!', '$=~', '$inject', '$const_get', '$split', '$const_missing', '$==', '$!', '$start_with?', '$to_proc', '$lambda', '$bind', '$call', '$class', '$append_features', '$included', '$name', '$cover?', '$size', '$merge', '$compile', '$proc', '$to_s', '$__id__', '$constants', '$include?']);
  return (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_22, TMP_23, TMP_24, TMP_25, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_35, TMP_36, TMP_37, TMP_38, TMP_39, TMP_41, TMP_42, TMP_43, TMP_44, TMP_45, TMP_46, TMP_47, TMP_48, TMP_49;

    Opal.defs(self, '$allocate', TMP_1 = function $$allocate() {
      var self = this;

      
      var module;

      module = Opal.module_allocate(self);
      Opal.create_scope(Opal.Module.$$scope, module, null);
      return module;
    
    }, TMP_1.$$arity = 0);

    Opal.defn(self, '$initialize', TMP_2 = function $$initialize() {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      return Opal.module_initialize(self, block);
    }, TMP_2.$$arity = 0);

    Opal.defn(self, '$===', TMP_3 = function(object) {
      var $a, self = this;

      if ((($a = object == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return false};
      return Opal.is_a(object, self);
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$<', TMP_4 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Module')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "compared with non class/module")
      };
      
      var working = self,
          ancestors,
          i, length;

      if (working === other) {
        return false;
      }

      for (i = 0, ancestors = Opal.ancestors(self), length = ancestors.length; i < length; i++) {
        if (ancestors[i] === other) {
          return true;
        }
      }

      for (i = 0, ancestors = Opal.ancestors(other), length = ancestors.length; i < length; i++) {
        if (ancestors[i] === self) {
          return false;
        }
      }

      return nil;
    
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$<=', TMP_5 = function(other) {
      var $a, self = this;

      return ((($a = self['$equal?'](other)) !== false && $a !== nil && $a != null) ? $a : $rb_lt(self, other));
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$>', TMP_6 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Module')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "compared with non class/module")
      };
      return $rb_lt(other, self);
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$>=', TMP_7 = function(other) {
      var $a, self = this;

      return ((($a = self['$equal?'](other)) !== false && $a !== nil && $a != null) ? $a : $rb_gt(self, other));
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$<=>', TMP_8 = function(other) {
      var $a, self = this, lt = nil;

      
      if (self === other) {
        return 0;
      }
    
      if ((($a = $scope.get('Module')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      lt = $rb_lt(self, other);
      if ((($a = lt['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if (lt !== false && lt !== nil && lt != null) {
        return -1
        } else {
        return 1
      };
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$alias_method', TMP_9 = function $$alias_method(newname, oldname) {
      var self = this;

      Opal.alias(self, newname, oldname);
      return self;
    }, TMP_9.$$arity = 2);

    Opal.defn(self, '$alias_native', TMP_10 = function $$alias_native(mid, jsid) {
      var self = this;

      if (jsid == null) {
        jsid = mid;
      }
      Opal.alias_native(self, mid, jsid);
      return self;
    }, TMP_10.$$arity = -2);

    Opal.defn(self, '$ancestors', TMP_11 = function $$ancestors() {
      var self = this;

      return Opal.ancestors(self);
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$append_features', TMP_12 = function $$append_features(klass) {
      var self = this;

      Opal.append_features(self, klass);
      return self;
    }, TMP_12.$$arity = 1);

    Opal.defn(self, '$attr_accessor', TMP_13 = function $$attr_accessor($a_rest) {
      var $b, $c, self = this, names;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      names = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        names[$arg_idx - 0] = arguments[$arg_idx];
      }
      ($b = self).$attr_reader.apply($b, Opal.to_a(names));
      return ($c = self).$attr_writer.apply($c, Opal.to_a(names));
    }, TMP_13.$$arity = -1);

    Opal.alias(self, 'attr', 'attr_accessor');

    Opal.defn(self, '$attr_reader', TMP_14 = function $$attr_reader($a_rest) {
      var self = this, names;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      names = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        names[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var proto = self.$$proto;

      for (var i = names.length - 1; i >= 0; i--) {
        var name = names[i],
            id   = '$' + name,
            ivar = Opal.ivar(name);

        // the closure here is needed because name will change at the next
        // cycle, I wish we could use let.
        var body = (function(ivar) {
          return function() {
            if (this[ivar] == null) {
              return nil;
            }
            else {
              return this[ivar];
            }
          };
        })(ivar);

        // initialize the instance variable as nil
        proto[ivar] = nil;

        body.$$parameters = [];
        body.$$arity = 0;

        if (self.$$is_singleton) {
          proto.constructor.prototype[id] = body;
        }
        else {
          Opal.defn(self, id, body);
        }
      }
    
      return nil;
    }, TMP_14.$$arity = -1);

    Opal.defn(self, '$attr_writer', TMP_15 = function $$attr_writer($a_rest) {
      var self = this, names;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      names = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        names[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var proto = self.$$proto;

      for (var i = names.length - 1; i >= 0; i--) {
        var name = names[i],
            id   = '$' + name + '=',
            ivar = Opal.ivar(name);

        // the closure here is needed because name will change at the next
        // cycle, I wish we could use let.
        var body = (function(ivar){
          return function(value) {
            return this[ivar] = value;
          }
        })(ivar);

        body.$$parameters = [['req']];
        body.$$arity = 1;

        // initialize the instance variable as nil
        proto[ivar] = nil;

        if (self.$$is_singleton) {
          proto.constructor.prototype[id] = body;
        }
        else {
          Opal.defn(self, id, body);
        }
      }
    
      return nil;
    }, TMP_15.$$arity = -1);

    Opal.defn(self, '$autoload', TMP_16 = function $$autoload(const$, path) {
      var self = this;

      
      var autoloaders;

      if (!(autoloaders = self.$$autoload)) {
        autoloaders = self.$$autoload = {};
      }

      autoloaders[const$] = path;
      return nil;
    ;
    }, TMP_16.$$arity = 2);

    Opal.defn(self, '$class_variable_get', TMP_17 = function $$class_variable_get(name) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = name.length < 3 || name.slice(0,2) !== '@@') !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError').$new("class vars should start with @@", name))};
      
      var value = Opal.cvars[name.slice(2)];
      (function() {if ((($a = value == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('NameError').$new("uninitialized class variable @@a in", name))
        } else {
        return nil
      }; return nil; })()
      return value;
    
    }, TMP_17.$$arity = 1);

    Opal.defn(self, '$class_variable_set', TMP_18 = function $$class_variable_set(name, value) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = name.length < 3 || name.slice(0,2) !== '@@') !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError'))};
      
      Opal.cvars[name.slice(2)] = value;
      return value;
    
    }, TMP_18.$$arity = 2);

    Opal.defn(self, '$constants', TMP_19 = function $$constants() {
      var self = this;

      return self.$$scope.constants.slice(0);
    }, TMP_19.$$arity = 0);

    Opal.defn(self, '$const_defined?', TMP_20 = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true;
      }
      name = $scope.get('Opal')['$const_name!'](name);
      if ((($a = name['$=~']((($scope.get('Opal')).$$scope.get('CONST_NAME_REGEXP')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError').$new("wrong constant name " + (name), name))
      };
      
      var scopes = [self.$$scope];

      if (inherit || self === Opal.Object) {
        var parent = self.$$super;

        while (parent !== Opal.BasicObject) {
          scopes.push(parent.$$scope);

          parent = parent.$$super;
        }
      }

      for (var i = 0, length = scopes.length; i < length; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return true;
        }
      }

      return false;
    
    }, TMP_20.$$arity = -2);

    Opal.defn(self, '$const_get', TMP_22 = function $$const_get(name, inherit) {
      var $a, $b, TMP_21, self = this;

      if (inherit == null) {
        inherit = true;
      }
      name = $scope.get('Opal')['$const_name!'](name);
      
      if (name.indexOf('::') === 0 && name !== '::'){
        name = name.slice(2);
      }
    
      if ((($a = name.indexOf('::') != -1 && name != '::') !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($a = ($b = name.$split("::")).$inject, $a.$$p = (TMP_21 = function(o, c){var self = TMP_21.$$s || this;
if (o == null) o = nil;if (c == null) c = nil;
        return o.$const_get(c)}, TMP_21.$$s = self, TMP_21.$$arity = 2, TMP_21), $a).call($b, self)};
      if ((($a = name['$=~']((($scope.get('Opal')).$$scope.get('CONST_NAME_REGEXP')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError').$new("wrong constant name " + (name), name))
      };
      
      var scopes = [self.$$scope];

      if (inherit || self == Opal.Object) {
        var parent = self.$$super;

        while (parent !== Opal.BasicObject) {
          scopes.push(parent.$$scope);

          parent = parent.$$super;
        }
      }

      for (var i = 0, length = scopes.length; i < length; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return scopes[i][name];
        }
      }

      return self.$const_missing(name);
    
    }, TMP_22.$$arity = -2);

    Opal.defn(self, '$const_missing', TMP_23 = function $$const_missing(name) {
      var self = this, full_const_name = nil;

      
      if (self.$$autoload) {
        var file = self.$$autoload[name];

        if (file) {
          self.$require(file);

          return self.$const_get(name);
        }
      }
    
      full_const_name = (function() {if (self['$==']($scope.get('Object'))) {
        return name
        } else {
        return "" + (self) + "::" + (name)
      }; return nil; })();
      return self.$raise($scope.get('NameError').$new("uninitialized constant " + (full_const_name), name));
    }, TMP_23.$$arity = 1);

    Opal.defn(self, '$const_set', TMP_24 = function $$const_set(name, value) {
      var $a, $b, self = this;

      name = $scope.get('Opal')['$const_name!'](name);
      if ((($a = ((($b = (name['$=~']((($scope.get('Opal')).$$scope.get('CONST_NAME_REGEXP'))))['$!']()) !== false && $b !== nil && $b != null) ? $b : name['$start_with?']("::"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError').$new("wrong constant name " + (name), name))};
      Opal.casgn(self, name, value);
      return value;
    }, TMP_24.$$arity = 2);

    Opal.defn(self, '$define_method', TMP_25 = function $$define_method(name, method) {
      var $a, $b, $c, TMP_26, self = this, $iter = TMP_25.$$p, block = $iter || nil, $case = nil;

      TMP_25.$$p = null;
      if ((($a = method === undefined && block === nil) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "tried to create a Proc object without a block")};
      ((($a = block) !== false && $a !== nil && $a != null) ? $a : block = (function() {$case = method;if ($scope.get('Proc')['$===']($case)) {return method}else if ($scope.get('Method')['$===']($case)) {return method.$to_proc().$$unbound;}else if ($scope.get('UnboundMethod')['$===']($case)) {return ($b = ($c = self).$lambda, $b.$$p = (TMP_26 = function($d_rest){var self = TMP_26.$$s || this, args, $e, bound = nil;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
      bound = method.$bind(self);
        return ($e = bound).$call.apply($e, Opal.to_a(args));}, TMP_26.$$s = self, TMP_26.$$arity = -1, TMP_26), $b).call($c)}else {return self.$raise($scope.get('TypeError'), "wrong argument type " + (block.$class()) + " (expected Proc/Method)")}})());
      
      var id = '$' + name;

      block.$$jsid        = name;
      block.$$s           = null;
      block.$$def         = block;
      block.$$define_meth = true;

      Opal.defn(self, id, block);

      return name;
    
    }, TMP_25.$$arity = -2);

    Opal.defn(self, '$remove_method', TMP_27 = function $$remove_method($a_rest) {
      var self = this, names;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      names = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        names[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = 0, length = names.length; i < length; i++) {
        Opal.rdef(self, "$" + names[i]);
      }
    
      return self;
    }, TMP_27.$$arity = -1);

    Opal.defn(self, '$singleton_class?', TMP_28 = function() {
      var self = this;

      return !!self.$$is_singleton;
    }, TMP_28.$$arity = 0);

    Opal.defn(self, '$include', TMP_29 = function $$include($a_rest) {
      var self = this, mods;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      mods = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        mods[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (mod === self) {
          continue;
        }

        if (!mod.$$is_module) {
          self.$raise($scope.get('TypeError'), "wrong argument type " + ((mod).$class()) + " (expected Module)");
        }

        (mod).$append_features(self);
        (mod).$included(self);
      }
    
      return self;
    }, TMP_29.$$arity = -1);

    Opal.defn(self, '$included_modules', TMP_30 = function $$included_modules() {
      var self = this;

      
      var results;

      var module_chain = function(klass) {
        var included = [];

        for (var i = 0; i != klass.$$inc.length; i++) {
          var mod_or_class = klass.$$inc[i];
          included.push(mod_or_class);
          included = included.concat(module_chain(mod_or_class));
        }

        return included;
      };

      results = module_chain(self);

      // need superclass's modules
      if (self.$$is_class) {
          for (var cls = self; cls; cls = cls.$$super) {
            results = results.concat(module_chain(cls));
          }
      }

      return results;
    
    }, TMP_30.$$arity = 0);

    Opal.defn(self, '$include?', TMP_31 = function(mod) {
      var self = this;

      
      for (var cls = self; cls; cls = cls.$$super) {
        for (var i = 0; i != cls.$$inc.length; i++) {
          var mod2 = cls.$$inc[i];
          if (mod === mod2) {
            return true;
          }
        }
      }
      return false;
    
    }, TMP_31.$$arity = 1);

    Opal.defn(self, '$instance_method', TMP_32 = function $$instance_method(name) {
      var self = this;

      
      var meth = self.$$proto['$' + name];

      if (!meth || meth.$$stub) {
        self.$raise($scope.get('NameError').$new("undefined method `" + (name) + "' for class `" + (self.$name()) + "'", name));
      }

      return $scope.get('UnboundMethod').$new(self, meth, name);
    
    }, TMP_32.$$arity = 1);

    Opal.defn(self, '$instance_methods', TMP_33 = function $$instance_methods(include_super) {
      var self = this;

      if (include_super == null) {
        include_super = true;
      }
      
      var methods = [],
          proto   = self.$$proto;

      for (var prop in proto) {
        if (prop.charAt(0) !== '$') {
          continue;
        }

        if (typeof(proto[prop]) !== "function") {
          continue;
        }

        if (proto[prop].$$stub) {
          continue;
        }

        if (!self.$$is_module) {
          if (self !== Opal.BasicObject && proto[prop] === Opal.BasicObject.$$proto[prop]) {
            continue;
          }

          if (!include_super && !proto.hasOwnProperty(prop)) {
            continue;
          }

          if (!include_super && proto[prop].$$donated) {
            continue;
          }
        }

        methods.push(prop.substr(1));
      }

      return methods;
    
    }, TMP_33.$$arity = -1);

    Opal.defn(self, '$included', TMP_34 = function $$included(mod) {
      var self = this;

      return nil;
    }, TMP_34.$$arity = 1);

    Opal.defn(self, '$extended', TMP_35 = function $$extended(mod) {
      var self = this;

      return nil;
    }, TMP_35.$$arity = 1);

    Opal.defn(self, '$method_added', TMP_36 = function $$method_added($a_rest) {
      var self = this;

      return nil;
    }, TMP_36.$$arity = -1);

    Opal.defn(self, '$method_removed', TMP_37 = function $$method_removed($a_rest) {
      var self = this;

      return nil;
    }, TMP_37.$$arity = -1);

    Opal.defn(self, '$method_undefined', TMP_38 = function $$method_undefined($a_rest) {
      var self = this;

      return nil;
    }, TMP_38.$$arity = -1);

    Opal.defn(self, '$module_eval', TMP_39 = function $$module_eval($a_rest) {
      var $b, $c, TMP_40, self = this, args, $iter = TMP_39.$$p, block = $iter || nil, string = nil, file = nil, _lineno = nil, default_eval_options = nil, compiling_options = nil, compiled = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_39.$$p = null;
      if ((($b = ($c = block['$nil?'](), $c !== false && $c !== nil && $c != null ?!!Opal.compile : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        if ((($b = ($range(1, 3, false))['$cover?'](args.$size())) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          } else {
          $scope.get('Kernel').$raise($scope.get('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        };
        $b = Opal.to_a(args), string = ($b[0] == null ? nil : $b[0]), file = ($b[1] == null ? nil : $b[1]), _lineno = ($b[2] == null ? nil : $b[2]), $b;
        default_eval_options = $hash2(["file", "eval"], {"file": (((($b = file) !== false && $b !== nil && $b != null) ? $b : "(eval)")), "eval": true});
        compiling_options = Opal.hash({ arity_check: false }).$merge(default_eval_options);
        compiled = $scope.get('Opal').$compile(string, compiling_options);
        block = ($b = ($c = $scope.get('Kernel')).$proc, $b.$$p = (TMP_40 = function(){var self = TMP_40.$$s || this;

        
          return (function(self) {
            return eval(compiled);
          })(self)
        }, TMP_40.$$s = self, TMP_40.$$arity = 0, TMP_40), $b).call($c);
      } else if ((($b = $rb_gt(args.$size(), 0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$size()) + " for 0)")};
      
      var old = block.$$s,
          result;

      block.$$s = null;
      result = block.apply(self, [self]);
      block.$$s = old;

      return result;
    
    }, TMP_39.$$arity = -1);

    Opal.alias(self, 'class_eval', 'module_eval');

    Opal.defn(self, '$module_exec', TMP_41 = function $$module_exec($a_rest) {
      var self = this, args, $iter = TMP_41.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_41.$$p = null;
      
      if (block === nil) {
        self.$raise($scope.get('LocalJumpError'), "no block given")
      }

      var block_self = block.$$s, result;

      block.$$s = null;
      result = block.apply(self, args);
      block.$$s = block_self;

      return result;
    ;
    }, TMP_41.$$arity = -1);

    Opal.alias(self, 'class_exec', 'module_exec');

    Opal.defn(self, '$method_defined?', TMP_42 = function(method) {
      var self = this;

      
      var body = self.$$proto['$' + method];
      return (!!body) && !body.$$stub;
    
    }, TMP_42.$$arity = 1);

    Opal.defn(self, '$module_function', TMP_43 = function $$module_function($a_rest) {
      var self = this, methods;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      methods = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        methods[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      if (methods.length === 0) {
        self.$$module_function = true;
      }
      else {
        for (var i = 0, length = methods.length; i < length; i++) {
          var meth = methods[i],
              id   = '$' + meth,
              func = self.$$proto[id];

          Opal.defs(self, id, func);
        }
      }

      return self;
    
    }, TMP_43.$$arity = -1);

    Opal.defn(self, '$name', TMP_44 = function $$name() {
      var self = this;

      
      if (self.$$full_name) {
        return self.$$full_name;
      }

      var result = [], base = self;

      while (base) {
        if (base.$$name === nil) {
          return result.length === 0 ? nil : result.join('::');
        }

        result.unshift(base.$$name);

        base = base.$$base_module;

        if (base === Opal.Object) {
          break;
        }
      }

      if (result.length === 0) {
        return nil;
      }

      return self.$$full_name = result.join('::');
    
    }, TMP_44.$$arity = 0);

    Opal.defn(self, '$remove_class_variable', TMP_45 = function $$remove_class_variable($a_rest) {
      var self = this;

      return nil;
    }, TMP_45.$$arity = -1);

    Opal.defn(self, '$remove_const', TMP_46 = function $$remove_const(name) {
      var self = this;

      
      var old = self.$$scope[name];
      delete self.$$scope[name];
      return old;
    
    }, TMP_46.$$arity = 1);

    Opal.defn(self, '$to_s', TMP_47 = function $$to_s() {
      var $a, self = this;

      return ((($a = Opal.Module.$name.call(self)) !== false && $a !== nil && $a != null) ? $a : "#<" + (self.$$is_module ? 'Module' : 'Class') + ":0x" + (self.$__id__().$to_s(16)) + ">");
    }, TMP_47.$$arity = 0);

    Opal.defn(self, '$undef_method', TMP_48 = function $$undef_method($a_rest) {
      var self = this, names;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      names = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        names[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = 0, length = names.length; i < length; i++) {
        Opal.udef(self, "$" + names[i]);
      }
    
      return self;
    }, TMP_48.$$arity = -1);

    return (Opal.defn(self, '$instance_variables', TMP_49 = function $$instance_variables() {
      var self = this, consts = nil;

      consts = self.$constants();
      
      var result = [];

      for (var name in self) {
        if (self.hasOwnProperty(name) && name.charAt(0) !== '$' && name !== 'constructor' && !consts['$include?'](name)) {
          result.push('@' + name);
        }
      }

      return result;
    
    }, TMP_49.$$arity = 0), nil) && 'instance_variables';
  })($scope.base, null)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/class"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$allocate', '$name', '$to_s']);
  self.$require("corelib/module");
  return (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6;

    Opal.defs(self, '$new', TMP_1 = function(superclass) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      if (superclass == null) {
        superclass = $scope.get('Object');
      }
      TMP_1.$$p = null;
      
      if (!superclass.$$is_class) {
        throw Opal.TypeError.$new("superclass must be a Class");
      }

      var alloc = Opal.boot_class_alloc(null, function(){}, superclass)
      var klass = Opal.setup_class_object(null, alloc, superclass.$$name, superclass.constructor);

      klass.$$super = superclass;
      klass.$$parent = superclass;

      // inherit scope from parent
      Opal.create_scope(superclass.$$scope, klass);

      superclass.$inherited(klass);
      Opal.module_initialize(klass, block);

      return klass;
    
    }, TMP_1.$$arity = -1);

    Opal.defn(self, '$allocate', TMP_2 = function $$allocate() {
      var self = this;

      
      var obj = new self.$$alloc();
      obj.$$id = Opal.uid();
      return obj;
    
    }, TMP_2.$$arity = 0);

    Opal.defn(self, '$inherited', TMP_3 = function $$inherited(cls) {
      var self = this;

      return nil;
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$new', TMP_4 = function($a_rest) {
      var self = this, args, $iter = TMP_4.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_4.$$p = null;
      
      var obj = self.$allocate();

      obj.$initialize.$$p = block;
      obj.$initialize.apply(obj, args);
      return obj;
    ;
    }, TMP_4.$$arity = -1);

    Opal.defn(self, '$superclass', TMP_5 = function $$superclass() {
      var self = this;

      return self.$$super || nil;
    }, TMP_5.$$arity = 0);

    return (Opal.defn(self, '$to_s', TMP_6 = function $$to_s() {
      var $a, $b, self = this, $iter = TMP_6.$$p, $yield = $iter || nil;

      TMP_6.$$p = null;
      
      var singleton_of = self.$$singleton_of;

      if (singleton_of && (singleton_of.$$is_class || singleton_of.$$is_module)) {
        return "#<Class:" + ((singleton_of).$name()) + ">";
      }
      else if (singleton_of) {
        // a singleton class created from an object
        return "#<Class:#<" + ((singleton_of.$$class).$name()) + ":0x" + ((singleton_of.$$id).$to_s(16)) + ">>";
      }
      return ($a = ($b = self, Opal.find_super_dispatcher(self, 'to_s', TMP_6, false)), $a.$$p = null, $a).call($b);
    
    }, TMP_6.$$arity = 0), nil) && 'to_s';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/basic_object"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range, $hash2 = Opal.hash2;

  Opal.add_stubs(['$==', '$!', '$nil?', '$cover?', '$size', '$raise', '$merge', '$compile', '$proc', '$>', '$new', '$inspect']);
  return (function($base, $super) {
    function $BasicObject(){};
    var self = $BasicObject = $klass($base, $super, 'BasicObject', $BasicObject);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14;

    Opal.defn(self, '$initialize', TMP_1 = function $$initialize($a_rest) {
      var self = this;

      return nil;
    }, TMP_1.$$arity = -1);

    Opal.defn(self, '$==', TMP_2 = function(other) {
      var self = this;

      return self === other;
    }, TMP_2.$$arity = 1);

    Opal.defn(self, '$eql?', TMP_3 = function(other) {
      var self = this;

      return self['$=='](other);
    }, TMP_3.$$arity = 1);

    Opal.alias(self, 'equal?', '==');

    Opal.defn(self, '$__id__', TMP_4 = function $$__id__() {
      var self = this;

      return self.$$id || (self.$$id = Opal.uid());
    }, TMP_4.$$arity = 0);

    Opal.defn(self, '$__send__', TMP_5 = function $$__send__(symbol, $a_rest) {
      var self = this, args, $iter = TMP_5.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      TMP_5.$$p = null;
      
      var func = self['$' + symbol]

      if (func) {
        if (block !== nil) {
          func.$$p = block;
        }

        return func.apply(self, args);
      }

      if (block !== nil) {
        self.$method_missing.$$p = block;
      }

      return self.$method_missing.apply(self, [symbol].concat(args));
    
    }, TMP_5.$$arity = -2);

    Opal.defn(self, '$!', TMP_6 = function() {
      var self = this;

      return false;
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$!=', TMP_7 = function(other) {
      var self = this;

      return (self['$=='](other))['$!']();
    }, TMP_7.$$arity = 1);

    Opal.alias(self, 'equal?', '==');

    Opal.defn(self, '$instance_eval', TMP_8 = function $$instance_eval($a_rest) {
      var $b, $c, TMP_9, self = this, args, $iter = TMP_8.$$p, block = $iter || nil, string = nil, file = nil, _lineno = nil, default_eval_options = nil, compiling_options = nil, compiled = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_8.$$p = null;
      if ((($b = ($c = block['$nil?'](), $c !== false && $c !== nil && $c != null ?!!Opal.compile : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        if ((($b = ($range(1, 3, false))['$cover?'](args.$size())) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          } else {
          $scope.get('Kernel').$raise($scope.get('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        };
        $b = Opal.to_a(args), string = ($b[0] == null ? nil : $b[0]), file = ($b[1] == null ? nil : $b[1]), _lineno = ($b[2] == null ? nil : $b[2]), $b;
        default_eval_options = $hash2(["file", "eval"], {"file": (((($b = file) !== false && $b !== nil && $b != null) ? $b : "(eval)")), "eval": true});
        compiling_options = Opal.hash({ arity_check: false }).$merge(default_eval_options);
        compiled = $scope.get('Opal').$compile(string, compiling_options);
        block = ($b = ($c = $scope.get('Kernel')).$proc, $b.$$p = (TMP_9 = function(){var self = TMP_9.$$s || this;

        
          return (function(self) {
            return eval(compiled);
          })(self)
        }, TMP_9.$$s = self, TMP_9.$$arity = 0, TMP_9), $b).call($c);
      } else if ((($b = $rb_gt(args.$size(), 0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$size()) + " for 0)")};
      
      var old = block.$$s,
          result;

      block.$$s = null;

      // Need to pass $$eval so that method definitions know if this is
      // being done on a class/module. Cannot be compiler driven since
      // send(:instance_eval) needs to work.
      if (self.$$is_class || self.$$is_module) {
        self.$$eval = true;
        try {
          result = block.call(self, self);
        }
        finally {
          self.$$eval = false;
        }
      }
      else {
        result = block.call(self, self);
      }

      block.$$s = old;

      return result;
    
    }, TMP_8.$$arity = -1);

    Opal.defn(self, '$instance_exec', TMP_10 = function $$instance_exec($a_rest) {
      var self = this, args, $iter = TMP_10.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_10.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var block_self = block.$$s,
          result;

      block.$$s = null;

      if (self.$$is_class || self.$$is_module) {
        self.$$eval = true;
        try {
          result = block.apply(self, args);
        }
        finally {
          self.$$eval = false;
        }
      }
      else {
        result = block.apply(self, args);
      }

      block.$$s = block_self;

      return result;
    
    }, TMP_10.$$arity = -1);

    Opal.defn(self, '$singleton_method_added', TMP_11 = function $$singleton_method_added($a_rest) {
      var self = this;

      return nil;
    }, TMP_11.$$arity = -1);

    Opal.defn(self, '$singleton_method_removed', TMP_12 = function $$singleton_method_removed($a_rest) {
      var self = this;

      return nil;
    }, TMP_12.$$arity = -1);

    Opal.defn(self, '$singleton_method_undefined', TMP_13 = function $$singleton_method_undefined($a_rest) {
      var self = this;

      return nil;
    }, TMP_13.$$arity = -1);

    return (Opal.defn(self, '$method_missing', TMP_14 = function $$method_missing(symbol, $a_rest) {
      var $b, self = this, args, $iter = TMP_14.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      TMP_14.$$p = null;
      return $scope.get('Kernel').$raise($scope.get('NoMethodError').$new((function() {if ((($b = self.$inspect && !self.$inspect.$$stub) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        return "undefined method `" + (symbol) + "' for " + (self.$inspect()) + ":" + (self.$$class)
        } else {
        return "undefined method `" + (symbol) + "' for " + (self.$$class)
      }; return nil; })(), symbol));
    }, TMP_14.$$arity = -2), nil) && 'method_missing';
  })($scope.base, null)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/kernel"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $gvars = Opal.gvars, $hash2 = Opal.hash2, $klass = Opal.klass;

  Opal.add_stubs(['$raise', '$new', '$inspect', '$!', '$=~', '$==', '$object_id', '$class', '$coerce_to?', '$<<', '$allocate', '$copy_instance_variables', '$copy_singleton_methods', '$initialize_clone', '$initialize_copy', '$define_method', '$to_proc', '$singleton_class', '$initialize_dup', '$for', '$>', '$size', '$pop', '$call', '$append_features', '$extended', '$length', '$respond_to?', '$[]', '$nil?', '$to_a', '$to_int', '$fetch', '$Integer', '$Float', '$to_ary', '$to_str', '$coerce_to', '$to_s', '$__id__', '$instance_variable_name!', '$coerce_to!', '$===', '$enum_for', '$print', '$format', '$puts', '$each', '$<=', '$empty?', '$exception', '$kind_of?', '$respond_to_missing?', '$try_convert!', '$expand_path', '$join', '$start_with?', '$sym', '$arg', '$open', '$include']);
  (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_35, TMP_36, TMP_37, TMP_38, TMP_39, TMP_40, TMP_41, TMP_42, TMP_43, TMP_45, TMP_46, TMP_47, TMP_48, TMP_49, TMP_50, TMP_51, TMP_52, TMP_53, TMP_54, TMP_55, TMP_56, TMP_57, TMP_58, TMP_59, TMP_60, TMP_61, TMP_62, TMP_63;

    Opal.defn(self, '$method_missing', TMP_1 = function $$method_missing(symbol, $a_rest) {
      var self = this, args, $iter = TMP_1.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      TMP_1.$$p = null;
      return self.$raise($scope.get('NoMethodError').$new("undefined method `" + (symbol) + "' for " + (self.$inspect()), symbol, args));
    }, TMP_1.$$arity = -2);

    Opal.defn(self, '$=~', TMP_2 = function(obj) {
      var self = this;

      return false;
    }, TMP_2.$$arity = 1);

    Opal.defn(self, '$!~', TMP_3 = function(obj) {
      var self = this;

      return (self['$=~'](obj))['$!']();
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$===', TMP_4 = function(other) {
      var $a, self = this;

      return ((($a = self.$object_id()['$=='](other.$object_id())) !== false && $a !== nil && $a != null) ? $a : self['$=='](other));
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$<=>', TMP_5 = function(other) {
      var self = this;

      
      // set guard for infinite recursion
      self.$$comparable = true;

      var x = self['$=='](other);

      if (x && x !== nil) {
        return 0;
      }

      return nil;
    
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$method', TMP_6 = function $$method(name) {
      var self = this;

      
      var meth = self['$' + name];

      if (!meth || meth.$$stub) {
        self.$raise($scope.get('NameError').$new("undefined method `" + (name) + "' for class `" + (self.$class()) + "'", name));
      }

      return $scope.get('Method').$new(self, meth, name);
    
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$methods', TMP_7 = function $$methods(all) {
      var self = this;

      if (all == null) {
        all = true;
      }
      
      var methods = [];

      for (var key in self) {
        if (key[0] == "$" && typeof(self[key]) === "function") {
          if (all == false || all === nil) {
            if (!Opal.hasOwnProperty.call(self, key)) {
              continue;
            }
          }
          if (self[key].$$stub === undefined) {
            methods.push(key.substr(1));
          }
        }
      }

      return methods;
    
    }, TMP_7.$$arity = -1);

    Opal.alias(self, 'public_methods', 'methods');

    Opal.defn(self, '$Array', TMP_8 = function $$Array(object) {
      var self = this;

      
      var coerced;

      if (object === nil) {
        return [];
      }

      if (object.$$is_array) {
        return object;
      }

      coerced = $scope.get('Opal')['$coerce_to?'](object, $scope.get('Array'), "to_ary");
      if (coerced !== nil) { return coerced; }

      coerced = $scope.get('Opal')['$coerce_to?'](object, $scope.get('Array'), "to_a");
      if (coerced !== nil) { return coerced; }

      return [object];
    
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$at_exit', TMP_9 = function $$at_exit() {
      var $a, self = this, $iter = TMP_9.$$p, block = $iter || nil;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      TMP_9.$$p = null;
      ((($a = $gvars.__at_exit__) !== false && $a !== nil && $a != null) ? $a : $gvars.__at_exit__ = []);
      return $gvars.__at_exit__['$<<'](block);
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$caller', TMP_10 = function $$caller() {
      var self = this;

      return [];
    }, TMP_10.$$arity = 0);

    Opal.defn(self, '$class', TMP_11 = function() {
      var self = this;

      return self.$$class;
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$copy_instance_variables', TMP_12 = function $$copy_instance_variables(other) {
      var self = this;

      
      for (var name in other) {
        if (other.hasOwnProperty(name) && name.charAt(0) !== '$') {
          self[name] = other[name];
        }
      }
    
    }, TMP_12.$$arity = 1);

    Opal.defn(self, '$copy_singleton_methods', TMP_13 = function $$copy_singleton_methods(other) {
      var self = this;

      
      var name;

      if (other.hasOwnProperty('$$meta')) {
        var other_singleton_class_proto = Opal.get_singleton_class(other).$$proto;
        var self_singleton_class_proto = Opal.get_singleton_class(self).$$proto;

        for (name in other_singleton_class_proto) {
          if (name.charAt(0) === '$' && other_singleton_class_proto.hasOwnProperty(name)) {
            self_singleton_class_proto[name] = other_singleton_class_proto[name];
          }
        }
      }

      for (name in other) {
        if (name.charAt(0) === '$' && name.charAt(1) !== '$' && other.hasOwnProperty(name)) {
          self[name] = other[name];
        }
      }
    
    }, TMP_13.$$arity = 1);

    Opal.defn(self, '$clone', TMP_14 = function $$clone() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$copy_singleton_methods(self);
      copy.$initialize_clone(self);
      return copy;
    }, TMP_14.$$arity = 0);

    Opal.defn(self, '$initialize_clone', TMP_15 = function $$initialize_clone(other) {
      var self = this;

      return self.$initialize_copy(other);
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$define_singleton_method', TMP_16 = function $$define_singleton_method(name, method) {
      var $a, $b, self = this, $iter = TMP_16.$$p, block = $iter || nil;

      TMP_16.$$p = null;
      return ($a = ($b = self.$singleton_class()).$define_method, $a.$$p = block.$to_proc(), $a).call($b, name, method);
    }, TMP_16.$$arity = -2);

    Opal.defn(self, '$dup', TMP_17 = function $$dup() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    }, TMP_17.$$arity = 0);

    Opal.defn(self, '$initialize_dup', TMP_18 = function $$initialize_dup(other) {
      var self = this;

      return self.$initialize_copy(other);
    }, TMP_18.$$arity = 1);

    Opal.defn(self, '$enum_for', TMP_19 = function $$enum_for(method, $a_rest) {
      var $b, $c, self = this, args, $iter = TMP_19.$$p, block = $iter || nil;

      if (method == null) {
        method = "each";
      }
      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      TMP_19.$$p = null;
      return ($b = ($c = $scope.get('Enumerator')).$for, $b.$$p = block.$to_proc(), $b).apply($c, [self, method].concat(Opal.to_a(args)));
    }, TMP_19.$$arity = -1);

    Opal.alias(self, 'to_enum', 'enum_for');

    Opal.defn(self, '$equal?', TMP_20 = function(other) {
      var self = this;

      return self === other;
    }, TMP_20.$$arity = 1);

    Opal.defn(self, '$exit', TMP_21 = function $$exit(status) {
      var $a, $b, self = this, block = nil;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      if (status == null) {
        status = true;
      }
      ((($a = $gvars.__at_exit__) !== false && $a !== nil && $a != null) ? $a : $gvars.__at_exit__ = []);
      while ((($b = $rb_gt($gvars.__at_exit__.$size(), 0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
      block = $gvars.__at_exit__.$pop();
      block.$call();};
      if ((($a = status === true) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        status = 0};
      Opal.exit(status);
      return nil;
    }, TMP_21.$$arity = -1);

    Opal.defn(self, '$extend', TMP_22 = function $$extend($a_rest) {
      var self = this, mods;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      mods = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        mods[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var singleton = self.$singleton_class();

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (!mod.$$is_module) {
          self.$raise($scope.get('TypeError'), "wrong argument type " + ((mod).$class()) + " (expected Module)");
        }

        (mod).$append_features(singleton);
        (mod).$extended(self);
      }
    ;
      return self;
    }, TMP_22.$$arity = -1);

    Opal.defn(self, '$format', TMP_23 = function $$format(format_string, $a_rest) {
      var $b, $c, self = this, args, ary = nil;
      if ($gvars.DEBUG == null) $gvars.DEBUG = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      if ((($b = (($c = args.$length()['$=='](1)) ? args['$[]'](0)['$respond_to?']("to_ary") : args.$length()['$=='](1))) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        ary = $scope.get('Opal')['$coerce_to?'](args['$[]'](0), $scope.get('Array'), "to_ary");
        if ((($b = ary['$nil?']()) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          } else {
          args = ary.$to_a()
        };};
      
      var result = '',
          //used for slicing:
          begin_slice = 0,
          end_slice,
          //used for iterating over the format string:
          i,
          len = format_string.length,
          //used for processing field values:
          arg,
          str,
          //used for processing %g and %G fields:
          exponent,
          //used for keeping track of width and precision:
          width,
          precision,
          //used for holding temporary values:
          tmp_num,
          //used for processing %{} and %<> fileds:
          hash_parameter_key,
          closing_brace_char,
          //used for processing %b, %B, %o, %x, and %X fields:
          base_number,
          base_prefix,
          base_neg_zero_regex,
          base_neg_zero_digit,
          //used for processing arguments:
          next_arg,
          seq_arg_num = 1,
          pos_arg_num = 0,
          //used for keeping track of flags:
          flags,
          FNONE  = 0,
          FSHARP = 1,
          FMINUS = 2,
          FPLUS  = 4,
          FZERO  = 8,
          FSPACE = 16,
          FWIDTH = 32,
          FPREC  = 64,
          FPREC0 = 128;

      function CHECK_FOR_FLAGS() {
        if (flags&FWIDTH) { self.$raise($scope.get('ArgumentError'), "flag after width") }
        if (flags&FPREC0) { self.$raise($scope.get('ArgumentError'), "flag after precision") }
      }

      function CHECK_FOR_WIDTH() {
        if (flags&FWIDTH) { self.$raise($scope.get('ArgumentError'), "width given twice") }
        if (flags&FPREC0) { self.$raise($scope.get('ArgumentError'), "width after precision") }
      }

      function GET_NTH_ARG(num) {
        if (num >= args.length) { self.$raise($scope.get('ArgumentError'), "too few arguments") }
        return args[num];
      }

      function GET_NEXT_ARG() {
        switch (pos_arg_num) {
        case -1: self.$raise($scope.get('ArgumentError'), "unnumbered(" + (seq_arg_num) + ") mixed with numbered")
        case -2: self.$raise($scope.get('ArgumentError'), "unnumbered(" + (seq_arg_num) + ") mixed with named")
        }
        pos_arg_num = seq_arg_num++;
        return GET_NTH_ARG(pos_arg_num - 1);
      }

      function GET_POS_ARG(num) {
        if (pos_arg_num > 0) {
          self.$raise($scope.get('ArgumentError'), "numbered(" + (num) + ") after unnumbered(" + (pos_arg_num) + ")")
        }
        if (pos_arg_num === -2) {
          self.$raise($scope.get('ArgumentError'), "numbered(" + (num) + ") after named")
        }
        if (num < 1) {
          self.$raise($scope.get('ArgumentError'), "invalid index - " + (num) + "$")
        }
        pos_arg_num = -1;
        return GET_NTH_ARG(num - 1);
      }

      function GET_ARG() {
        return (next_arg === undefined ? GET_NEXT_ARG() : next_arg);
      }

      function READ_NUM(label) {
        var num, str = '';
        for (;; i++) {
          if (i === len) {
            self.$raise($scope.get('ArgumentError'), "malformed format string - %*[0-9]")
          }
          if (format_string.charCodeAt(i) < 48 || format_string.charCodeAt(i) > 57) {
            i--;
            num = parseInt(str, 10) || 0;
            if (num > 2147483647) {
              self.$raise($scope.get('ArgumentError'), "" + (label) + " too big")
            }
            return num;
          }
          str += format_string.charAt(i);
        }
      }

      function READ_NUM_AFTER_ASTER(label) {
        var arg, num = READ_NUM(label);
        if (format_string.charAt(i + 1) === '$') {
          i++;
          arg = GET_POS_ARG(num);
        } else {
          arg = GET_NEXT_ARG();
        }
        return (arg).$to_int();
      }

      for (i = format_string.indexOf('%'); i !== -1; i = format_string.indexOf('%', i)) {
        str = undefined;

        flags = FNONE;
        width = -1;
        precision = -1;
        next_arg = undefined;

        end_slice = i;

        i++;

        switch (format_string.charAt(i)) {
        case '%':
          begin_slice = i;
        case '':
        case '\n':
        case '\0':
          i++;
          continue;
        }

        format_sequence: for (; i < len; i++) {
          switch (format_string.charAt(i)) {

          case ' ':
            CHECK_FOR_FLAGS();
            flags |= FSPACE;
            continue format_sequence;

          case '#':
            CHECK_FOR_FLAGS();
            flags |= FSHARP;
            continue format_sequence;

          case '+':
            CHECK_FOR_FLAGS();
            flags |= FPLUS;
            continue format_sequence;

          case '-':
            CHECK_FOR_FLAGS();
            flags |= FMINUS;
            continue format_sequence;

          case '0':
            CHECK_FOR_FLAGS();
            flags |= FZERO;
            continue format_sequence;

          case '1':
          case '2':
          case '3':
          case '4':
          case '5':
          case '6':
          case '7':
          case '8':
          case '9':
            tmp_num = READ_NUM('width');
            if (format_string.charAt(i + 1) === '$') {
              if (i + 2 === len) {
                str = '%';
                i++;
                break format_sequence;
              }
              if (next_arg !== undefined) {
                self.$raise($scope.get('ArgumentError'), "value given twice - %" + (tmp_num) + "$")
              }
              next_arg = GET_POS_ARG(tmp_num);
              i++;
            } else {
              CHECK_FOR_WIDTH();
              flags |= FWIDTH;
              width = tmp_num;
            }
            continue format_sequence;

          case '<':
          case '\{':
            closing_brace_char = (format_string.charAt(i) === '<' ? '>' : '\}');
            hash_parameter_key = '';

            i++;

            for (;; i++) {
              if (i === len) {
                self.$raise($scope.get('ArgumentError'), "malformed name - unmatched parenthesis")
              }
              if (format_string.charAt(i) === closing_brace_char) {

                if (pos_arg_num > 0) {
                  self.$raise($scope.get('ArgumentError'), "named " + (hash_parameter_key) + " after unnumbered(" + (pos_arg_num) + ")")
                }
                if (pos_arg_num === -1) {
                  self.$raise($scope.get('ArgumentError'), "named " + (hash_parameter_key) + " after numbered")
                }
                pos_arg_num = -2;

                if (args[0] === undefined || !args[0].$$is_hash) {
                  self.$raise($scope.get('ArgumentError'), "one hash required")
                }

                next_arg = (args[0]).$fetch(hash_parameter_key);

                if (closing_brace_char === '>') {
                  continue format_sequence;
                } else {
                  str = next_arg.toString();
                  if (precision !== -1) { str = str.slice(0, precision); }
                  if (flags&FMINUS) {
                    while (str.length < width) { str = str + ' '; }
                  } else {
                    while (str.length < width) { str = ' ' + str; }
                  }
                  break format_sequence;
                }
              }
              hash_parameter_key += format_string.charAt(i);
            }

          case '*':
            i++;
            CHECK_FOR_WIDTH();
            flags |= FWIDTH;
            width = READ_NUM_AFTER_ASTER('width');
            if (width < 0) {
              flags |= FMINUS;
              width = -width;
            }
            continue format_sequence;

          case '.':
            if (flags&FPREC0) {
              self.$raise($scope.get('ArgumentError'), "precision given twice")
            }
            flags |= FPREC|FPREC0;
            precision = 0;
            i++;
            if (format_string.charAt(i) === '*') {
              i++;
              precision = READ_NUM_AFTER_ASTER('precision');
              if (precision < 0) {
                flags &= ~FPREC;
              }
              continue format_sequence;
            }
            precision = READ_NUM('precision');
            continue format_sequence;

          case 'd':
          case 'i':
          case 'u':
            arg = self.$Integer(GET_ARG());
            if (arg >= 0) {
              str = arg.toString();
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0)) { str = '0' + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              str = (-arg).toString();
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                str = '-' + str;
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - 1) { str = '0' + str; }
                  str = '-' + str;
                } else {
                  str = '-' + str;
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            }
            break format_sequence;

          case 'b':
          case 'B':
          case 'o':
          case 'x':
          case 'X':
            switch (format_string.charAt(i)) {
            case 'b':
            case 'B':
              base_number = 2;
              base_prefix = '0b';
              base_neg_zero_regex = /^1+/;
              base_neg_zero_digit = '1';
              break;
            case 'o':
              base_number = 8;
              base_prefix = '0';
              base_neg_zero_regex = /^3?7+/;
              base_neg_zero_digit = '7';
              break;
            case 'x':
            case 'X':
              base_number = 16;
              base_prefix = '0x';
              base_neg_zero_regex = /^f+/;
              base_neg_zero_digit = 'f';
              break;
            }
            arg = self.$Integer(GET_ARG());
            if (arg >= 0) {
              str = arg.toString(base_number);
              while (str.length < precision) { str = '0' + str; }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && precision === -1) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0) - ((flags&FSHARP && arg !== 0) ? base_prefix.length : 0)) { str = '0' + str; }
                  if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FSHARP && arg !== 0) { str = base_prefix + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              if (flags&FPLUS || flags&FSPACE) {
                str = (-arg).toString(base_number);
                while (str.length < precision) { str = '0' + str; }
                if (flags&FMINUS) {
                  if (flags&FSHARP) { str = base_prefix + str; }
                  str = '-' + str;
                  while (str.length < width) { str = str + ' '; }
                } else {
                  if (flags&FZERO && precision === -1) {
                    while (str.length < width - 1 - (flags&FSHARP ? 2 : 0)) { str = '0' + str; }
                    if (flags&FSHARP) { str = base_prefix + str; }
                    str = '-' + str;
                  } else {
                    if (flags&FSHARP) { str = base_prefix + str; }
                    str = '-' + str;
                    while (str.length < width) { str = ' ' + str; }
                  }
                }
              } else {
                str = (arg >>> 0).toString(base_number).replace(base_neg_zero_regex, base_neg_zero_digit);
                while (str.length < precision - 2) { str = base_neg_zero_digit + str; }
                if (flags&FMINUS) {
                  str = '..' + str;
                  if (flags&FSHARP) { str = base_prefix + str; }
                  while (str.length < width) { str = str + ' '; }
                } else {
                  if (flags&FZERO && precision === -1) {
                    while (str.length < width - 2 - (flags&FSHARP ? base_prefix.length : 0)) { str = base_neg_zero_digit + str; }
                    str = '..' + str;
                    if (flags&FSHARP) { str = base_prefix + str; }
                  } else {
                    str = '..' + str;
                    if (flags&FSHARP) { str = base_prefix + str; }
                    while (str.length < width) { str = ' ' + str; }
                  }
                }
              }
            }
            if (format_string.charAt(i) === format_string.charAt(i).toUpperCase()) {
              str = str.toUpperCase();
            }
            break format_sequence;

          case 'f':
          case 'e':
          case 'E':
          case 'g':
          case 'G':
            arg = self.$Float(GET_ARG());
            if (arg >= 0 || isNaN(arg)) {
              if (arg === Infinity) {
                str = 'Inf';
              } else {
                switch (format_string.charAt(i)) {
                case 'f':
                  str = arg.toFixed(precision === -1 ? 6 : precision);
                  break;
                case 'e':
                case 'E':
                  str = arg.toExponential(precision === -1 ? 6 : precision);
                  break;
                case 'g':
                case 'G':
                  str = arg.toExponential();
                  exponent = parseInt(str.split('e')[1], 10);
                  if (!(exponent < -4 || exponent >= (precision === -1 ? 6 : precision))) {
                    str = arg.toPrecision(precision === -1 ? (flags&FSHARP ? 6 : undefined) : precision);
                  }
                  break;
                }
              }
              if (flags&FMINUS) {
                if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && arg !== Infinity && !isNaN(arg)) {
                  while (str.length < width - ((flags&FPLUS || flags&FSPACE) ? 1 : 0)) { str = '0' + str; }
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                } else {
                  if (flags&FPLUS || flags&FSPACE) { str = (flags&FPLUS ? '+' : ' ') + str; }
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            } else {
              if (arg === -Infinity) {
                str = 'Inf';
              } else {
                switch (format_string.charAt(i)) {
                case 'f':
                  str = (-arg).toFixed(precision === -1 ? 6 : precision);
                  break;
                case 'e':
                case 'E':
                  str = (-arg).toExponential(precision === -1 ? 6 : precision);
                  break;
                case 'g':
                case 'G':
                  str = (-arg).toExponential();
                  exponent = parseInt(str.split('e')[1], 10);
                  if (!(exponent < -4 || exponent >= (precision === -1 ? 6 : precision))) {
                    str = (-arg).toPrecision(precision === -1 ? (flags&FSHARP ? 6 : undefined) : precision);
                  }
                  break;
                }
              }
              if (flags&FMINUS) {
                str = '-' + str;
                while (str.length < width) { str = str + ' '; }
              } else {
                if (flags&FZERO && arg !== -Infinity) {
                  while (str.length < width - 1) { str = '0' + str; }
                  str = '-' + str;
                } else {
                  str = '-' + str;
                  while (str.length < width) { str = ' ' + str; }
                }
              }
            }
            if (format_string.charAt(i) === format_string.charAt(i).toUpperCase() && arg !== Infinity && arg !== -Infinity && !isNaN(arg)) {
              str = str.toUpperCase();
            }
            str = str.replace(/([eE][-+]?)([0-9])$/, '$10$2');
            break format_sequence;

          case 'a':
          case 'A':
            // Not implemented because there are no specs for this field type.
            self.$raise($scope.get('NotImplementedError'), "`A` and `a` format field types are not implemented in Opal yet")

          case 'c':
            arg = GET_ARG();
            if ((arg)['$respond_to?']("to_ary")) { arg = (arg).$to_ary()[0]; }
            if ((arg)['$respond_to?']("to_str")) {
              str = (arg).$to_str();
            } else {
              str = String.fromCharCode($scope.get('Opal').$coerce_to(arg, $scope.get('Integer'), "to_int"));
            }
            if (str.length !== 1) {
              self.$raise($scope.get('ArgumentError'), "%c requires a character")
            }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          case 'p':
            str = (GET_ARG()).$inspect();
            if (precision !== -1) { str = str.slice(0, precision); }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          case 's':
            str = (GET_ARG()).$to_s();
            if (precision !== -1) { str = str.slice(0, precision); }
            if (flags&FMINUS) {
              while (str.length < width) { str = str + ' '; }
            } else {
              while (str.length < width) { str = ' ' + str; }
            }
            break format_sequence;

          default:
            self.$raise($scope.get('ArgumentError'), "malformed format string - %" + (format_string.charAt(i)))
          }
        }

        if (str === undefined) {
          self.$raise($scope.get('ArgumentError'), "malformed format string - %")
        }

        result += format_string.slice(begin_slice, end_slice) + str;
        begin_slice = i + 1;
      }

      if ($gvars.DEBUG && pos_arg_num >= 0 && seq_arg_num < args.length) {
        self.$raise($scope.get('ArgumentError'), "too many arguments for format string")
      }

      return result + format_string.slice(begin_slice);
    ;
    }, TMP_23.$$arity = -2);

    Opal.defn(self, '$hash', TMP_24 = function $$hash() {
      var self = this;

      return self.$__id__();
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$initialize_copy', TMP_25 = function $$initialize_copy(other) {
      var self = this;

      return nil;
    }, TMP_25.$$arity = 1);

    Opal.defn(self, '$inspect', TMP_26 = function $$inspect() {
      var self = this;

      return self.$to_s();
    }, TMP_26.$$arity = 0);

    Opal.defn(self, '$instance_of?', TMP_27 = function(klass) {
      var self = this;

      
      if (!klass.$$is_class && !klass.$$is_module) {
        self.$raise($scope.get('TypeError'), "class or module required");
      }

      return self.$$class === klass;
    ;
    }, TMP_27.$$arity = 1);

    Opal.defn(self, '$instance_variable_defined?', TMP_28 = function(name) {
      var self = this;

      name = $scope.get('Opal')['$instance_variable_name!'](name);
      return Opal.hasOwnProperty.call(self, name.substr(1));
    }, TMP_28.$$arity = 1);

    Opal.defn(self, '$instance_variable_get', TMP_29 = function $$instance_variable_get(name) {
      var self = this;

      name = $scope.get('Opal')['$instance_variable_name!'](name);
      
      var ivar = self[Opal.ivar(name.substr(1))];

      return ivar == null ? nil : ivar;
    
    }, TMP_29.$$arity = 1);

    Opal.defn(self, '$instance_variable_set', TMP_30 = function $$instance_variable_set(name, value) {
      var self = this;

      name = $scope.get('Opal')['$instance_variable_name!'](name);
      return self[Opal.ivar(name.substr(1))] = value;
    }, TMP_30.$$arity = 2);

    Opal.defn(self, '$remove_instance_variable', TMP_31 = function $$remove_instance_variable(name) {
      var self = this;

      name = $scope.get('Opal')['$instance_variable_name!'](name);
      
      var key = Opal.ivar(name.substr(1)),
          val;
      if (self.hasOwnProperty(key)) {
        val = self[key];
        delete self[key];
        return val;
      }
    
      return self.$raise($scope.get('NameError'), "instance variable " + (name) + " not defined");
    }, TMP_31.$$arity = 1);

    Opal.defn(self, '$instance_variables', TMP_32 = function $$instance_variables() {
      var self = this;

      
      var result = [], ivar;

      for (var name in self) {
        if (self.hasOwnProperty(name) && name.charAt(0) !== '$') {
          if (name.substr(-1) === '$') {
            ivar = name.slice(0, name.length - 1);
          } else {
            ivar = name;
          }
          result.push('@' + ivar);
        }
      }

      return result;
    
    }, TMP_32.$$arity = 0);

    Opal.defn(self, '$Integer', TMP_33 = function $$Integer(value, base) {
      var self = this;

      
      var i, str, base_digits;

      if (!value.$$is_string) {
        if (base !== undefined) {
          self.$raise($scope.get('ArgumentError'), "base specified for non string value")
        }
        if (value === nil) {
          self.$raise($scope.get('TypeError'), "can't convert nil into Integer")
        }
        if (value.$$is_number) {
          if (value === Infinity || value === -Infinity || isNaN(value)) {
            self.$raise($scope.get('FloatDomainError'), value)
          }
          return Math.floor(value);
        }
        if (value['$respond_to?']("to_int")) {
          i = value.$to_int();
          if (i !== nil) {
            return i;
          }
        }
        return $scope.get('Opal')['$coerce_to!'](value, $scope.get('Integer'), "to_i");
      }

      if (base === undefined) {
        base = 0;
      } else {
        base = $scope.get('Opal').$coerce_to(base, $scope.get('Integer'), "to_int");
        if (base === 1 || base < 0 || base > 36) {
          self.$raise($scope.get('ArgumentError'), "invalid radix " + (base))
        }
      }

      str = value.toLowerCase();

      str = str.replace(/(\d)_(?=\d)/g, '$1');

      str = str.replace(/^(\s*[+-]?)(0[bodx]?)/, function (_, head, flag) {
        switch (flag) {
        case '0b':
          if (base === 0 || base === 2) {
            base = 2;
            return head;
          }
        case '0':
        case '0o':
          if (base === 0 || base === 8) {
            base = 8;
            return head;
          }
        case '0d':
          if (base === 0 || base === 10) {
            base = 10;
            return head;
          }
        case '0x':
          if (base === 0 || base === 16) {
            base = 16;
            return head;
          }
        }
        self.$raise($scope.get('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      });

      base = (base === 0 ? 10 : base);

      base_digits = '0-' + (base <= 10 ? base - 1 : '9a-' + String.fromCharCode(97 + (base - 11)));

      if (!(new RegExp('^\\s*[+-]?[' + base_digits + ']+\\s*$')).test(str)) {
        self.$raise($scope.get('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      }

      i = parseInt(str, base);

      if (isNaN(i)) {
        self.$raise($scope.get('ArgumentError'), "invalid value for Integer(): \"" + (value) + "\"")
      }

      return i;
    ;
    }, TMP_33.$$arity = -2);

    Opal.defn(self, '$Float', TMP_34 = function $$Float(value) {
      var self = this;

      
      var str;

      if (value === nil) {
        self.$raise($scope.get('TypeError'), "can't convert nil into Float")
      }

      if (value.$$is_string) {
        str = value.toString();

        str = str.replace(/(\d)_(?=\d)/g, '$1');

        //Special case for hex strings only:
        if (/^\s*[-+]?0[xX][0-9a-fA-F]+\s*$/.test(str)) {
          return self.$Integer(str);
        }

        if (!/^\s*[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?\s*$/.test(str)) {
          self.$raise($scope.get('ArgumentError'), "invalid value for Float(): \"" + (value) + "\"")
        }

        return parseFloat(str);
      }

      return $scope.get('Opal')['$coerce_to!'](value, $scope.get('Float'), "to_f");
    
    }, TMP_34.$$arity = 1);

    Opal.defn(self, '$Hash', TMP_35 = function $$Hash(arg) {
      var $a, $b, self = this;

      if ((($a = ((($b = arg['$nil?']()) !== false && $b !== nil && $b != null) ? $b : arg['$==']([]))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $hash2([], {})};
      if ((($a = $scope.get('Hash')['$==='](arg)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return arg};
      return $scope.get('Opal')['$coerce_to!'](arg, $scope.get('Hash'), "to_hash");
    }, TMP_35.$$arity = 1);

    Opal.defn(self, '$is_a?', TMP_36 = function(klass) {
      var self = this;

      
      if (!klass.$$is_class && !klass.$$is_module) {
        self.$raise($scope.get('TypeError'), "class or module required");
      }

      return Opal.is_a(self, klass);
    ;
    }, TMP_36.$$arity = 1);

    Opal.alias(self, 'kind_of?', 'is_a?');

    Opal.defn(self, '$lambda', TMP_37 = function $$lambda() {
      var self = this, $iter = TMP_37.$$p, block = $iter || nil;

      TMP_37.$$p = null;
      block.$$is_lambda = true;
      return block;
    }, TMP_37.$$arity = 0);

    Opal.defn(self, '$load', TMP_38 = function $$load(file) {
      var self = this;

      file = $scope.get('Opal')['$coerce_to!'](file, $scope.get('String'), "to_str");
      return Opal.load(file);
    }, TMP_38.$$arity = 1);

    Opal.defn(self, '$loop', TMP_39 = function $$loop() {
      var self = this, $iter = TMP_39.$$p, $yield = $iter || nil;

      TMP_39.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("loop")
      };
      
      while (true) {
        Opal.yieldX($yield, [])
      }
    ;
      return self;
    }, TMP_39.$$arity = 0);

    Opal.defn(self, '$nil?', TMP_40 = function() {
      var self = this;

      return false;
    }, TMP_40.$$arity = 0);

    Opal.alias(self, 'object_id', '__id__');

    Opal.defn(self, '$printf', TMP_41 = function $$printf($a_rest) {
      var $b, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      if ((($b = $rb_gt(args.$length(), 0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        self.$print(($b = self).$format.apply($b, Opal.to_a(args)))};
      return nil;
    }, TMP_41.$$arity = -1);

    Opal.defn(self, '$proc', TMP_42 = function $$proc() {
      var self = this, $iter = TMP_42.$$p, block = $iter || nil;

      TMP_42.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create Proc object without a block")
      };
      block.$$is_lambda = false;
      return block;
    }, TMP_42.$$arity = 0);

    Opal.defn(self, '$puts', TMP_43 = function $$puts($a_rest) {
      var $b, self = this, strs;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      strs = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        strs[$arg_idx - 0] = arguments[$arg_idx];
      }
      return ($b = $gvars.stdout).$puts.apply($b, Opal.to_a(strs));
    }, TMP_43.$$arity = -1);

    Opal.defn(self, '$p', TMP_45 = function $$p($a_rest) {
      var $b, $c, TMP_44, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      ($b = ($c = args).$each, $b.$$p = (TMP_44 = function(obj){var self = TMP_44.$$s || this;
        if ($gvars.stdout == null) $gvars.stdout = nil;
if (obj == null) obj = nil;
      return $gvars.stdout.$puts(obj.$inspect())}, TMP_44.$$s = self, TMP_44.$$arity = 1, TMP_44), $b).call($c);
      if ((($b = $rb_le(args.$length(), 1)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        return args['$[]'](0)
        } else {
        return args
      };
    }, TMP_45.$$arity = -1);

    Opal.defn(self, '$print', TMP_46 = function $$print($a_rest) {
      var $b, self = this, strs;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      strs = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        strs[$arg_idx - 0] = arguments[$arg_idx];
      }
      return ($b = $gvars.stdout).$print.apply($b, Opal.to_a(strs));
    }, TMP_46.$$arity = -1);

    Opal.defn(self, '$warn', TMP_47 = function $$warn($a_rest) {
      var $b, $c, self = this, strs;
      if ($gvars.VERBOSE == null) $gvars.VERBOSE = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      strs = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        strs[$arg_idx - 0] = arguments[$arg_idx];
      }
      if ((($b = ((($c = $gvars.VERBOSE['$nil?']()) !== false && $c !== nil && $c != null) ? $c : strs['$empty?']())) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        return nil
        } else {
        return ($b = $gvars.stderr).$puts.apply($b, Opal.to_a(strs))
      };
    }, TMP_47.$$arity = -1);

    Opal.defn(self, '$raise', TMP_48 = function $$raise(exception, string, _backtrace) {
      var self = this;
      if ($gvars["!"] == null) $gvars["!"] = nil;

      if (string == null) {
        string = nil;
      }
      if (_backtrace == null) {
        _backtrace = nil;
      }
      
      if (exception == null && $gvars["!"] !== nil) {
        throw $gvars["!"];
      }
      if (exception == null) {
        exception = $scope.get('RuntimeError').$new();
      }
      else if (exception.$$is_string) {
        exception = $scope.get('RuntimeError').$new(exception);
      }
      // using respond_to? and not an undefined check to avoid method_missing matching as true
      else if (exception.$$is_class && exception['$respond_to?']("exception")) {
        exception = exception.$exception(string);
      }
      else if (exception['$kind_of?']($scope.get('Exception'))) {
        // exception is fine
      }
      else {
        exception = $scope.get('TypeError').$new("exception class/object expected");
      }

      if ($gvars["!"] !== nil) {
        Opal.exceptions.push($gvars["!"]);
      }

      $gvars["!"] = exception;

      throw exception;
    ;
    }, TMP_48.$$arity = -1);

    Opal.alias(self, 'fail', 'raise');

    Opal.defn(self, '$rand', TMP_49 = function $$rand(max) {
      var self = this;

      
      if (max === undefined) {
        return Math.random();
      }
      else if (max.$$is_range) {
        var min = max.begin, range = max.end - min;
        if(!max.exclude) range++;

        return self.$rand(range) + min;
      }
      else {
        return Math.floor(Math.random() *
          Math.abs($scope.get('Opal').$coerce_to(max, $scope.get('Integer'), "to_int")));
      }
    
    }, TMP_49.$$arity = -1);

    Opal.defn(self, '$respond_to?', TMP_50 = function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false;
      }
      if ((($a = self['$respond_to_missing?'](name, include_all)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      
      var body = self['$' + name];

      if (typeof(body) === "function" && !body.$$stub) {
        return true;
      }
    
      return false;
    }, TMP_50.$$arity = -2);

    Opal.defn(self, '$respond_to_missing?', TMP_51 = function(method_name, include_all) {
      var self = this;

      if (include_all == null) {
        include_all = false;
      }
      return false;
    }, TMP_51.$$arity = -2);

    Opal.defn(self, '$require', TMP_52 = function $$require(file) {
      var self = this;

      file = $scope.get('Opal')['$coerce_to!'](file, $scope.get('String'), "to_str");
      return Opal.require(file);
    }, TMP_52.$$arity = 1);

    Opal.defn(self, '$require_relative', TMP_53 = function $$require_relative(file) {
      var self = this;

      $scope.get('Opal')['$try_convert!'](file, $scope.get('String'), "to_str");
      file = $scope.get('File').$expand_path($scope.get('File').$join(Opal.current_file, "..", file));
      return Opal.require(file);
    }, TMP_53.$$arity = 1);

    Opal.defn(self, '$require_tree', TMP_54 = function $$require_tree(path) {
      var self = this;

      path = $scope.get('File').$expand_path(path);
      if (path['$=='](".")) {
        path = ""};
      
      for (var name in Opal.modules) {
        if ((name)['$start_with?'](path)) {
          Opal.require(name);
        }
      }
    ;
      return nil;
    }, TMP_54.$$arity = 1);

    Opal.alias(self, 'send', '__send__');

    Opal.alias(self, 'public_send', '__send__');

    Opal.defn(self, '$singleton_class', TMP_55 = function $$singleton_class() {
      var self = this;

      return Opal.get_singleton_class(self);
    }, TMP_55.$$arity = 0);

    Opal.defn(self, '$sleep', TMP_56 = function $$sleep(seconds) {
      var self = this;

      if (seconds == null) {
        seconds = nil;
      }
      
      if (seconds === nil) {
        self.$raise($scope.get('TypeError'), "can't convert NilClass into time interval")
      }
      if (!seconds.$$is_number) {
        self.$raise($scope.get('TypeError'), "can't convert " + (seconds.$class()) + " into time interval")
      }
      if (seconds < 0) {
        self.$raise($scope.get('ArgumentError'), "time interval must be positive")
      }
      var t = new Date();
      while (new Date() - t <= seconds * 1000);
      return seconds;
    ;
    }, TMP_56.$$arity = -1);

    Opal.alias(self, 'sprintf', 'format');

    Opal.alias(self, 'srand', 'rand');

    Opal.defn(self, '$String', TMP_57 = function $$String(str) {
      var $a, self = this;

      return ((($a = $scope.get('Opal')['$coerce_to?'](str, $scope.get('String'), "to_str")) !== false && $a !== nil && $a != null) ? $a : $scope.get('Opal')['$coerce_to!'](str, $scope.get('String'), "to_s"));
    }, TMP_57.$$arity = 1);

    Opal.defn(self, '$tap', TMP_58 = function $$tap() {
      var self = this, $iter = TMP_58.$$p, block = $iter || nil;

      TMP_58.$$p = null;
      Opal.yield1(block, self);
      return self;
    }, TMP_58.$$arity = 0);

    Opal.defn(self, '$to_proc', TMP_59 = function $$to_proc() {
      var self = this;

      return self;
    }, TMP_59.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_60 = function $$to_s() {
      var self = this;

      return "#<" + (self.$class()) + ":0x" + (self.$__id__().$to_s(16)) + ">";
    }, TMP_60.$$arity = 0);

    Opal.defn(self, '$catch', TMP_61 = function(sym) {
      var self = this, $iter = TMP_61.$$p, $yield = $iter || nil, e = nil;

      TMP_61.$$p = null;
      try {
        return Opal.yieldX($yield, []);
      } catch ($err) {
        if (Opal.rescue($err, [$scope.get('UncaughtThrowError')])) {e = $err;
          try {
            if (e.$sym()['$=='](sym)) {
              return e.$arg()};
            return self.$raise();
          } finally { Opal.pop_exception() }
        } else { throw $err; }
      };
    }, TMP_61.$$arity = 1);

    Opal.defn(self, '$throw', TMP_62 = function($a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      return self.$raise($scope.get('UncaughtThrowError').$new(args));
    }, TMP_62.$$arity = -1);

    Opal.defn(self, '$open', TMP_63 = function $$open($a_rest) {
      var $b, $c, self = this, args, $iter = TMP_63.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_63.$$p = null;
      return ($b = ($c = $scope.get('File')).$open, $b.$$p = block.$to_proc(), $b).apply($c, Opal.to_a(args));
    }, TMP_63.$$arity = -1);
  })($scope.base);
  return (function($base, $super) {
    function $Object(){};
    var self = $Object = $klass($base, $super, 'Object', $Object);

    var def = self.$$proto, $scope = self.$$scope;

    return self.$include($scope.get('Kernel'))
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/error"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module;

  Opal.add_stubs(['$new', '$clone', '$to_s', '$empty?', '$class', '$attr_reader', '$[]', '$>', '$length', '$inspect']);
  (function($base, $super) {
    function $Exception(){};
    var self = $Exception = $klass($base, $super, 'Exception', $Exception);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8;

    def.message = nil;
    Opal.defs(self, '$new', TMP_1 = function($a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var message = (args.length > 0) ? args[0] : nil;
      var err = new self.$$alloc(message);

      if (Error.captureStackTrace) {
        Error.captureStackTrace(err);
      }

      err.name = self.$$name;
      err.$initialize.apply(err, args);
      return err;
    
    }, TMP_1.$$arity = -1);

    Opal.defs(self, '$exception', TMP_2 = function $$exception($a_rest) {
      var $b, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      return ($b = self).$new.apply($b, Opal.to_a(args));
    }, TMP_2.$$arity = -1);

    Opal.defn(self, '$initialize', TMP_3 = function $$initialize($a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      return self.message = (args.length > 0) ? args[0] : nil;
    }, TMP_3.$$arity = -1);

    Opal.defn(self, '$backtrace', TMP_4 = function $$backtrace() {
      var self = this;

      
      var backtrace = self.stack;

      if (typeof(backtrace) === 'string') {
        return backtrace.split("\n").slice(0, 15);
      }
      else if (backtrace) {
        return backtrace.slice(0, 15);
      }

      return [];
    
    }, TMP_4.$$arity = 0);

    Opal.defn(self, '$exception', TMP_5 = function $$exception(str) {
      var self = this;

      if (str == null) {
        str = nil;
      }
      
      if (str === nil || self === str) {
        return self;
      }
      
      var cloned = self.$clone();
      cloned.message = str;
      return cloned;
    
    }, TMP_5.$$arity = -1);

    Opal.defn(self, '$message', TMP_6 = function $$message() {
      var self = this;

      return self.$to_s();
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$inspect', TMP_7 = function $$inspect() {
      var $a, self = this, as_str = nil;

      as_str = self.$to_s();
      if ((($a = as_str['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$class().$to_s()
        } else {
        return "#<" + (self.$class().$to_s()) + ": " + (self.$to_s()) + ">"
      };
    }, TMP_7.$$arity = 0);

    return (Opal.defn(self, '$to_s', TMP_8 = function $$to_s() {
      var $a, $b, self = this;

      return ((($a = (($b = self.message, $b !== false && $b !== nil && $b != null ?self.message.$to_s() : $b))) !== false && $a !== nil && $a != null) ? $a : self.$class().$to_s());
    }, TMP_8.$$arity = 0), nil) && 'to_s';
  })($scope.base, Error);
  (function($base, $super) {
    function $ScriptError(){};
    var self = $ScriptError = $klass($base, $super, 'ScriptError', $ScriptError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $SyntaxError(){};
    var self = $SyntaxError = $klass($base, $super, 'SyntaxError', $SyntaxError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('ScriptError'));
  (function($base, $super) {
    function $LoadError(){};
    var self = $LoadError = $klass($base, $super, 'LoadError', $LoadError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('ScriptError'));
  (function($base, $super) {
    function $NotImplementedError(){};
    var self = $NotImplementedError = $klass($base, $super, 'NotImplementedError', $NotImplementedError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('ScriptError'));
  (function($base, $super) {
    function $SystemExit(){};
    var self = $SystemExit = $klass($base, $super, 'SystemExit', $SystemExit);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $NoMemoryError(){};
    var self = $NoMemoryError = $klass($base, $super, 'NoMemoryError', $NoMemoryError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $SignalException(){};
    var self = $SignalException = $klass($base, $super, 'SignalException', $SignalException);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $Interrupt(){};
    var self = $Interrupt = $klass($base, $super, 'Interrupt', $Interrupt);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $SecurityError(){};
    var self = $SecurityError = $klass($base, $super, 'SecurityError', $SecurityError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $StandardError(){};
    var self = $StandardError = $klass($base, $super, 'StandardError', $StandardError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('Exception'));
  (function($base, $super) {
    function $ZeroDivisionError(){};
    var self = $ZeroDivisionError = $klass($base, $super, 'ZeroDivisionError', $ZeroDivisionError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $NameError(){};
    var self = $NameError = $klass($base, $super, 'NameError', $NameError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $NoMethodError(){};
    var self = $NoMethodError = $klass($base, $super, 'NoMethodError', $NoMethodError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('NameError'));
  (function($base, $super) {
    function $RuntimeError(){};
    var self = $RuntimeError = $klass($base, $super, 'RuntimeError', $RuntimeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $LocalJumpError(){};
    var self = $LocalJumpError = $klass($base, $super, 'LocalJumpError', $LocalJumpError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $TypeError(){};
    var self = $TypeError = $klass($base, $super, 'TypeError', $TypeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $ArgumentError(){};
    var self = $ArgumentError = $klass($base, $super, 'ArgumentError', $ArgumentError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $IndexError(){};
    var self = $IndexError = $klass($base, $super, 'IndexError', $IndexError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $StopIteration(){};
    var self = $StopIteration = $klass($base, $super, 'StopIteration', $StopIteration);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('IndexError'));
  (function($base, $super) {
    function $KeyError(){};
    var self = $KeyError = $klass($base, $super, 'KeyError', $KeyError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('IndexError'));
  (function($base, $super) {
    function $RangeError(){};
    var self = $RangeError = $klass($base, $super, 'RangeError', $RangeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $FloatDomainError(){};
    var self = $FloatDomainError = $klass($base, $super, 'FloatDomainError', $FloatDomainError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('RangeError'));
  (function($base, $super) {
    function $IOError(){};
    var self = $IOError = $klass($base, $super, 'IOError', $IOError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $SystemCallError(){};
    var self = $SystemCallError = $klass($base, $super, 'SystemCallError', $SystemCallError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base) {
    var $Errno, self = $Errno = $module($base, 'Errno');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $EINVAL(){};
      var self = $EINVAL = $klass($base, $super, 'EINVAL', $EINVAL);

      var def = self.$$proto, $scope = self.$$scope, TMP_9;

      return (Opal.defs(self, '$new', TMP_9 = function() {
        var $a, $b, self = this, $iter = TMP_9.$$p, $yield = $iter || nil;

        TMP_9.$$p = null;
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'new', TMP_9, false, $EINVAL)), $a.$$p = null, $a).call($b, "Invalid argument");
      }, TMP_9.$$arity = 0), nil) && 'new'
    })($scope.base, $scope.get('SystemCallError'))
  })($scope.base);
  (function($base, $super) {
    function $UncaughtThrowError(){};
    var self = $UncaughtThrowError = $klass($base, $super, 'UncaughtThrowError', $UncaughtThrowError);

    var def = self.$$proto, $scope = self.$$scope, TMP_10;

    def.sym = nil;
    self.$attr_reader("sym", "arg");

    return (Opal.defn(self, '$initialize', TMP_10 = function $$initialize(args) {
      var $a, $b, self = this, $iter = TMP_10.$$p, $yield = $iter || nil;

      TMP_10.$$p = null;
      self.sym = args['$[]'](0);
      if ((($a = $rb_gt(args.$length(), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.arg = args['$[]'](1)};
      return ($a = ($b = self, Opal.find_super_dispatcher(self, 'initialize', TMP_10, false)), $a.$$p = null, $a).call($b, "uncaught throw " + (self.sym.$inspect()));
    }, TMP_10.$$arity = 1), nil) && 'initialize';
  })($scope.base, $scope.get('ArgumentError'));
  (function($base, $super) {
    function $NameError(){};
    var self = $NameError = $klass($base, $super, 'NameError', $NameError);

    var def = self.$$proto, $scope = self.$$scope, TMP_11;

    self.$attr_reader("name");

    return (Opal.defn(self, '$initialize', TMP_11 = function $$initialize(message, name) {
      var $a, $b, self = this, $iter = TMP_11.$$p, $yield = $iter || nil;

      if (name == null) {
        name = nil;
      }
      TMP_11.$$p = null;
      ($a = ($b = self, Opal.find_super_dispatcher(self, 'initialize', TMP_11, false)), $a.$$p = null, $a).call($b, message);
      return self.name = name;
    }, TMP_11.$$arity = -2), nil) && 'initialize';
  })($scope.base, null);
  return (function($base, $super) {
    function $NoMethodError(){};
    var self = $NoMethodError = $klass($base, $super, 'NoMethodError', $NoMethodError);

    var def = self.$$proto, $scope = self.$$scope, TMP_12;

    self.$attr_reader("args");

    return (Opal.defn(self, '$initialize', TMP_12 = function $$initialize(message, name, args) {
      var $a, $b, self = this, $iter = TMP_12.$$p, $yield = $iter || nil;

      if (name == null) {
        name = nil;
      }
      if (args == null) {
        args = [];
      }
      TMP_12.$$p = null;
      ($a = ($b = self, Opal.find_super_dispatcher(self, 'initialize', TMP_12, false)), $a.$$p = null, $a).call($b, message, name);
      return self.args = args;
    }, TMP_12.$$arity = -2), nil) && 'initialize';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/constants"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.cdecl($scope, 'RUBY_PLATFORM', "opal");
  Opal.cdecl($scope, 'RUBY_ENGINE', "opal");
  Opal.cdecl($scope, 'RUBY_VERSION', "2.2.5");
  Opal.cdecl($scope, 'RUBY_ENGINE_VERSION', "0.10.3");
  Opal.cdecl($scope, 'RUBY_RELEASE_DATE', "2016-10-31");
  Opal.cdecl($scope, 'RUBY_PATCHLEVEL', 0);
  Opal.cdecl($scope, 'RUBY_REVISION', 0);
  Opal.cdecl($scope, 'RUBY_COPYRIGHT', "opal - Copyright (C) 2013-2015 Adam Beynon");
  return Opal.cdecl($scope, 'RUBY_DESCRIPTION', "opal " + ($scope.get('RUBY_ENGINE_VERSION')) + " (" + ($scope.get('RUBY_RELEASE_DATE')) + " revision " + ($scope.get('RUBY_REVISION')) + ")");
};

/* Generated by Opal 0.10.3 */
Opal.modules["opal/base"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("corelib/runtime");
  self.$require("corelib/helpers");
  self.$require("corelib/module");
  self.$require("corelib/class");
  self.$require("corelib/basic_object");
  self.$require("corelib/kernel");
  self.$require("corelib/error");
  return self.$require("corelib/constants");
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/nil"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise', '$class', '$new', '$>', '$length', '$Rational']);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18;

    def.$$meta = self;

    Opal.defn(self, '$!', TMP_1 = function() {
      var self = this;

      return true;
    }, TMP_1.$$arity = 0);

    Opal.defn(self, '$&', TMP_2 = function(other) {
      var self = this;

      return false;
    }, TMP_2.$$arity = 1);

    Opal.defn(self, '$|', TMP_3 = function(other) {
      var self = this;

      return other !== false && other !== nil;
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$^', TMP_4 = function(other) {
      var self = this;

      return other !== false && other !== nil;
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$==', TMP_5 = function(other) {
      var self = this;

      return other === nil;
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$dup', TMP_6 = function $$dup() {
      var self = this;

      return self.$raise($scope.get('TypeError'), "can't dup " + (self.$class()));
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$clone', TMP_7 = function $$clone() {
      var self = this;

      return self.$raise($scope.get('TypeError'), "can't clone " + (self.$class()));
    }, TMP_7.$$arity = 0);

    Opal.defn(self, '$inspect', TMP_8 = function $$inspect() {
      var self = this;

      return "nil";
    }, TMP_8.$$arity = 0);

    Opal.defn(self, '$nil?', TMP_9 = function() {
      var self = this;

      return true;
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$singleton_class', TMP_10 = function $$singleton_class() {
      var self = this;

      return $scope.get('NilClass');
    }, TMP_10.$$arity = 0);

    Opal.defn(self, '$to_a', TMP_11 = function $$to_a() {
      var self = this;

      return [];
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$to_h', TMP_12 = function $$to_h() {
      var self = this;

      return Opal.hash();
    }, TMP_12.$$arity = 0);

    Opal.defn(self, '$to_i', TMP_13 = function $$to_i() {
      var self = this;

      return 0;
    }, TMP_13.$$arity = 0);

    Opal.alias(self, 'to_f', 'to_i');

    Opal.defn(self, '$to_s', TMP_14 = function $$to_s() {
      var self = this;

      return "";
    }, TMP_14.$$arity = 0);

    Opal.defn(self, '$to_c', TMP_15 = function $$to_c() {
      var self = this;

      return $scope.get('Complex').$new(0, 0);
    }, TMP_15.$$arity = 0);

    Opal.defn(self, '$rationalize', TMP_16 = function $$rationalize($a_rest) {
      var $b, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      if ((($b = $rb_gt(args.$length(), 1)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        self.$raise($scope.get('ArgumentError'))};
      return self.$Rational(0, 1);
    }, TMP_16.$$arity = -1);

    Opal.defn(self, '$to_r', TMP_17 = function $$to_r() {
      var self = this;

      return self.$Rational(0, 1);
    }, TMP_17.$$arity = 0);

    return (Opal.defn(self, '$instance_variables', TMP_18 = function $$instance_variables() {
      var self = this;

      return [];
    }, TMP_18.$$arity = 0), nil) && 'instance_variables';
  })($scope.base, null);
  return Opal.cdecl($scope, 'NIL', nil);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/boolean"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise', '$class']);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10;

    def.$$is_boolean = true;

    def.$$meta = self;

    Opal.defn(self, '$__id__', TMP_1 = function $$__id__() {
      var self = this;

      return self.valueOf() ? 2 : 0;
    }, TMP_1.$$arity = 0);

    Opal.alias(self, 'object_id', '__id__');

    Opal.defn(self, '$!', TMP_2 = function() {
      var self = this;

      return self != true;
    }, TMP_2.$$arity = 0);

    Opal.defn(self, '$&', TMP_3 = function(other) {
      var self = this;

      return (self == true) ? (other !== false && other !== nil) : false;
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$|', TMP_4 = function(other) {
      var self = this;

      return (self == true) ? true : (other !== false && other !== nil);
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$^', TMP_5 = function(other) {
      var self = this;

      return (self == true) ? (other === false || other === nil) : (other !== false && other !== nil);
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$==', TMP_6 = function(other) {
      var self = this;

      return (self == true) === other.valueOf();
    }, TMP_6.$$arity = 1);

    Opal.alias(self, 'equal?', '==');

    Opal.alias(self, 'eql?', '==');

    Opal.defn(self, '$singleton_class', TMP_7 = function $$singleton_class() {
      var self = this;

      return $scope.get('Boolean');
    }, TMP_7.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_8 = function $$to_s() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, TMP_8.$$arity = 0);

    Opal.defn(self, '$dup', TMP_9 = function $$dup() {
      var self = this;

      return self.$raise($scope.get('TypeError'), "can't dup " + (self.$class()));
    }, TMP_9.$$arity = 0);

    return (Opal.defn(self, '$clone', TMP_10 = function $$clone() {
      var self = this;

      return self.$raise($scope.get('TypeError'), "can't clone " + (self.$class()));
    }, TMP_10.$$arity = 0), nil) && 'clone';
  })($scope.base, Boolean);
  Opal.cdecl($scope, 'TrueClass', $scope.get('Boolean'));
  Opal.cdecl($scope, 'FalseClass', $scope.get('Boolean'));
  Opal.cdecl($scope, 'TRUE', true);
  return Opal.cdecl($scope, 'FALSE', false);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/comparable"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$===', '$>', '$<', '$equal?', '$<=>', '$normalize', '$raise', '$class']);
  return (function($base) {
    var $Comparable, self = $Comparable = $module($base, 'Comparable');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7;

    Opal.defs(self, '$normalize', TMP_1 = function $$normalize(what) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](what)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return what};
      if ((($a = $rb_gt(what, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return 1};
      if ((($a = $rb_lt(what, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return -1};
      return 0;
    }, TMP_1.$$arity = 1);

    Opal.defn(self, '$==', TMP_2 = function(other) {
      var $a, self = this, cmp = nil;

      try {
        if ((($a = self['$equal?'](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return true};
        
      if (self["$<=>"] == Opal.Kernel["$<=>"]) {
        return false;
      }

      // check for infinite recursion
      if (self.$$comparable) {
        delete self.$$comparable;
        return false;
      }
    
        if ((($a = cmp = (self['$<=>'](other))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          return false
        };
        return $scope.get('Comparable').$normalize(cmp) == 0;
      } catch ($err) {
        if (Opal.rescue($err, [$scope.get('StandardError')])) {
          try {
            return false
          } finally { Opal.pop_exception() }
        } else { throw $err; }
      };
    }, TMP_2.$$arity = 1);

    Opal.defn(self, '$>', TMP_3 = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) > 0;
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$>=', TMP_4 = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) >= 0;
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$<', TMP_5 = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) < 0;
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$<=', TMP_6 = function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) <= 0;
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$between?', TMP_7 = function(min, max) {
      var self = this;

      if ($rb_lt(self, min)) {
        return false};
      if ($rb_gt(self, max)) {
        return false};
      return true;
    }, TMP_7.$$arity = 2);
  })($scope.base)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/regexp"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$nil?', '$[]', '$raise', '$escape', '$options', '$to_str', '$new', '$join', '$coerce_to!', '$!', '$match', '$coerce_to?', '$begin', '$coerce_to', '$call', '$=~', '$attr_reader', '$===', '$inspect', '$to_a']);
  (function($base, $super) {
    function $RegexpError(){};
    var self = $RegexpError = $klass($base, $super, 'RegexpError', $RegexpError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })($scope.base, $scope.get('StandardError'));
  (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self.$$proto, $scope = self.$$scope, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15;

    Opal.cdecl($scope, 'IGNORECASE', 1);

    Opal.cdecl($scope, 'MULTILINE', 4);

    def.$$is_regexp = true;

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5;

      Opal.defn(self, '$allocate', TMP_1 = function $$allocate() {
        var $a, $b, self = this, $iter = TMP_1.$$p, $yield = $iter || nil, allocated = nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

        TMP_1.$$p = null;
        $zuper = [];
        
        for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
          $zuper[$zuper_index] = arguments[$zuper_index];
        }
        allocated = ($a = ($b = self, Opal.find_super_dispatcher(self, 'allocate', TMP_1, false)), $a.$$p = $iter, $a).apply($b, $zuper);
        allocated.uninitialized = true;
        return allocated;
      }, TMP_1.$$arity = 0);
      Opal.defn(self, '$escape', TMP_2 = function $$escape(string) {
        var self = this;

        
        return string.replace(/([-[\]\/{}()*+?.^$\\| ])/g, '\\$1')
                     .replace(/[\n]/g, '\\n')
                     .replace(/[\r]/g, '\\r')
                     .replace(/[\f]/g, '\\f')
                     .replace(/[\t]/g, '\\t');
      
      }, TMP_2.$$arity = 1);
      Opal.defn(self, '$last_match', TMP_3 = function $$last_match(n) {
        var $a, self = this;
        if ($gvars["~"] == null) $gvars["~"] = nil;

        if (n == null) {
          n = nil;
        }
        if ((($a = n['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return $gvars["~"]
          } else {
          return $gvars["~"]['$[]'](n)
        };
      }, TMP_3.$$arity = -1);
      Opal.alias(self, 'quote', 'escape');
      Opal.defn(self, '$union', TMP_4 = function $$union($a_rest) {
        var self = this, parts;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        parts = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          parts[$arg_idx - 0] = arguments[$arg_idx];
        }
        
        var is_first_part_array, quoted_validated, part, options, each_part_options;
        if (parts.length == 0) {
          return /(?!)/;
        }
        // cover the 2 arrays passed as arguments case
        is_first_part_array = parts[0].$$is_array;
        if (parts.length > 1 && is_first_part_array) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of Array into String")
        }        
        // deal with splat issues (related to https://github.com/opal/opal/issues/858)
        if (is_first_part_array) {
          parts = parts[0];
        }
        options = undefined;
        quoted_validated = [];
        for (var i=0; i < parts.length; i++) {
          part = parts[i];
          if (part.$$is_string) {
            quoted_validated.push(self.$escape(part));
          }
          else if (part.$$is_regexp) {
            each_part_options = (part).$options();
            if (options != undefined && options != each_part_options) {
              self.$raise($scope.get('TypeError'), "All expressions must use the same options")
            }
            options = each_part_options;
            quoted_validated.push('('+part.source+')');
          }
          else {
            quoted_validated.push(self.$escape((part).$to_str()));
          }
        }
      
        return self.$new((quoted_validated).$join("|"), options);
      }, TMP_4.$$arity = -1);
      return (Opal.defn(self, '$new', TMP_5 = function(regexp, options) {
        var self = this;

        
        if (regexp.$$is_regexp) {
          return new RegExp(regexp);
        }

        regexp = $scope.get('Opal')['$coerce_to!'](regexp, $scope.get('String'), "to_str");

        if (regexp.charAt(regexp.length - 1) === '\\' && regexp.charAt(regexp.length - 2) !== '\\') {
          self.$raise($scope.get('RegexpError'), "too short escape sequence: /" + (regexp) + "/")
        }

        if (options === undefined || options['$!']()) {
          return new RegExp(regexp);
        }

        if (options.$$is_number) {
          var temp = '';
          if ($scope.get('IGNORECASE') & options) { temp += 'i'; }
          if ($scope.get('MULTILINE')  & options) { temp += 'm'; }
          options = temp;
        }
        else {
          options = 'i';
        }

        return new RegExp(regexp, options);
      ;
      }, TMP_5.$$arity = -2), nil) && 'new';
    })(Opal.get_singleton_class(self));

    Opal.defn(self, '$==', TMP_6 = function(other) {
      var self = this;

      return other.constructor == RegExp && self.toString() === other.toString();
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$===', TMP_7 = function(string) {
      var self = this;

      return self.$match($scope.get('Opal')['$coerce_to?'](string, $scope.get('String'), "to_str")) !== nil;
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$=~', TMP_8 = function(string) {
      var $a, self = this;
      if ($gvars["~"] == null) $gvars["~"] = nil;

      return ($a = self.$match(string), $a !== false && $a !== nil && $a != null ?$gvars["~"].$begin(0) : $a);
    }, TMP_8.$$arity = 1);

    Opal.alias(self, 'eql?', '==');

    Opal.defn(self, '$inspect', TMP_9 = function $$inspect() {
      var self = this;

      return self.toString();
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$match', TMP_10 = function $$match(string, pos) {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;
      if ($gvars["~"] == null) $gvars["~"] = nil;

      TMP_10.$$p = null;
      
      if (self.uninitialized) {
        self.$raise($scope.get('TypeError'), "uninitialized Regexp")
      }

      if (pos === undefined) {
        pos = 0;
      } else {
        pos = $scope.get('Opal').$coerce_to(pos, $scope.get('Integer'), "to_int");
      }

      if (string === nil) {
        return $gvars["~"] = nil;
      }

      string = $scope.get('Opal').$coerce_to(string, $scope.get('String'), "to_str");

      if (pos < 0) {
        pos += string.length;
        if (pos < 0) {
          return $gvars["~"] = nil;
        }
      }

      var source = self.source;
      var flags = 'g';
      // m flag + a . in Ruby will match white space, but in JS, it only matches beginning/ending of lines, so we get the equivalent here
      if (self.multiline) {
        source = source.replace('.', "[\\s\\S]");
        flags += 'm';
      }

      // global RegExp maintains state, so not using self/this
      var md, re = new RegExp(source, flags + (self.ignoreCase ? 'i' : ''));

      while (true) {
        md = re.exec(string);
        if (md === null) {
          return $gvars["~"] = nil;
        }
        if (md.index >= pos) {
          $gvars["~"] = $scope.get('MatchData').$new(re, md)
          return block === nil ? $gvars["~"] : block.$call($gvars["~"]);
        }
        re.lastIndex = md.index + 1;
      }
    ;
    }, TMP_10.$$arity = -2);

    Opal.defn(self, '$~', TMP_11 = function() {
      var self = this;
      if ($gvars._ == null) $gvars._ = nil;

      return self['$=~']($gvars._);
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$source', TMP_12 = function $$source() {
      var self = this;

      return self.source;
    }, TMP_12.$$arity = 0);

    Opal.defn(self, '$options', TMP_13 = function $$options() {
      var self = this;

      
      if (self.uninitialized) {
        self.$raise($scope.get('TypeError'), "uninitialized Regexp")
      }
      var result = 0;
      // should be supported in IE6 according to https://msdn.microsoft.com/en-us/library/7f5z26w4(v=vs.94).aspx
      if (self.multiline) {
        result |= $scope.get('MULTILINE');
      }
      if (self.ignoreCase) {
        result |= $scope.get('IGNORECASE');
      }
      return result;
    ;
    }, TMP_13.$$arity = 0);

    Opal.defn(self, '$casefold?', TMP_14 = function() {
      var self = this;

      return self.ignoreCase;
    }, TMP_14.$$arity = 0);

    Opal.alias(self, 'to_s', 'source');

    return (Opal.defs(self, '$_load', TMP_15 = function $$_load(args) {
      var $a, self = this;

      return ($a = self).$new.apply($a, Opal.to_a(args));
    }, TMP_15.$$arity = 1), nil) && '_load';
  })($scope.base, RegExp);
  return (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self.$$proto, $scope = self.$$scope, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27;

    def.matches = nil;
    self.$attr_reader("post_match", "pre_match", "regexp", "string");

    Opal.defn(self, '$initialize', TMP_16 = function $$initialize(regexp, match_groups) {
      var self = this;

      $gvars["~"] = self;
      self.regexp = regexp;
      self.begin = match_groups.index;
      self.string = match_groups.input;
      self.pre_match = match_groups.input.slice(0, match_groups.index);
      self.post_match = match_groups.input.slice(match_groups.index + match_groups[0].length);
      self.matches = [];
      
      for (var i = 0, length = match_groups.length; i < length; i++) {
        var group = match_groups[i];

        if (group == null) {
          self.matches.push(nil);
        }
        else {
          self.matches.push(group);
        }
      }
    
    }, TMP_16.$$arity = 2);

    Opal.defn(self, '$[]', TMP_17 = function($a_rest) {
      var $b, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      return ($b = self.matches)['$[]'].apply($b, Opal.to_a(args));
    }, TMP_17.$$arity = -1);

    Opal.defn(self, '$offset', TMP_18 = function $$offset(n) {
      var self = this;

      
      if (n !== 0) {
        self.$raise($scope.get('ArgumentError'), "MatchData#offset only supports 0th element")
      }
      return [self.begin, self.begin + self.matches[n].length];
    ;
    }, TMP_18.$$arity = 1);

    Opal.defn(self, '$==', TMP_19 = function(other) {
      var $a, $b, $c, $d, self = this;

      if ((($a = $scope.get('MatchData')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = ($c = ($d = self.string == other.string, $d !== false && $d !== nil && $d != null ?self.regexp.toString() == other.regexp.toString() : $d), $c !== false && $c !== nil && $c != null ?self.pre_match == other.pre_match : $c), $b !== false && $b !== nil && $b != null ?self.post_match == other.post_match : $b), $a !== false && $a !== nil && $a != null ?self.begin == other.begin : $a);
    }, TMP_19.$$arity = 1);

    Opal.alias(self, 'eql?', '==');

    Opal.defn(self, '$begin', TMP_20 = function $$begin(n) {
      var self = this;

      
      if (n !== 0) {
        self.$raise($scope.get('ArgumentError'), "MatchData#begin only supports 0th element")
      }
      return self.begin;
    ;
    }, TMP_20.$$arity = 1);

    Opal.defn(self, '$end', TMP_21 = function $$end(n) {
      var self = this;

      
      if (n !== 0) {
        self.$raise($scope.get('ArgumentError'), "MatchData#end only supports 0th element")
      }
      return self.begin + self.matches[n].length;
    ;
    }, TMP_21.$$arity = 1);

    Opal.defn(self, '$captures', TMP_22 = function $$captures() {
      var self = this;

      return self.matches.slice(1);
    }, TMP_22.$$arity = 0);

    Opal.defn(self, '$inspect', TMP_23 = function $$inspect() {
      var self = this;

      
      var str = "#<MatchData " + (self.matches[0]).$inspect();

      for (var i = 1, length = self.matches.length; i < length; i++) {
        str += " " + i + ":" + (self.matches[i]).$inspect();
      }

      return str + ">";
    ;
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$length', TMP_24 = function $$length() {
      var self = this;

      return self.matches.length;
    }, TMP_24.$$arity = 0);

    Opal.alias(self, 'size', 'length');

    Opal.defn(self, '$to_a', TMP_25 = function $$to_a() {
      var self = this;

      return self.matches;
    }, TMP_25.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_26 = function $$to_s() {
      var self = this;

      return self.matches[0];
    }, TMP_26.$$arity = 0);

    return (Opal.defn(self, '$values_at', TMP_27 = function $$values_at($a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var i, a, index, values = [];

      for (i = 0; i < args.length; i++) {

        if (args[i].$$is_range) {
          a = (args[i]).$to_a();
          a.unshift(i, 1);
          Array.prototype.splice.apply(args, a);
        }

        index = $scope.get('Opal')['$coerce_to!'](args[i], $scope.get('Integer'), "to_int");

        if (index < 0) {
          index += self.matches.length;
          if (index < 0) {
            values.push(nil);
            continue;
          }
        }

        values.push(self.matches[index]);
      }

      return values;
    
    }, TMP_27.$$arity = -1), nil) && 'values_at';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/string"] = function(Opal) {
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$require', '$include', '$coerce_to?', '$coerce_to', '$raise', '$===', '$format', '$to_s', '$respond_to?', '$to_str', '$<=>', '$==', '$=~', '$new', '$empty?', '$ljust', '$ceil', '$/', '$+', '$rjust', '$floor', '$to_a', '$each_char', '$to_proc', '$coerce_to!', '$copy_singleton_methods', '$initialize_clone', '$initialize_dup', '$enum_for', '$size', '$chomp', '$[]', '$to_i', '$each_line', '$class', '$match', '$captures', '$proc', '$shift', '$__send__', '$succ', '$escape']);
  self.$require("corelib/comparable");
  self.$require("corelib/regexp");
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_35, TMP_36, TMP_37, TMP_38, TMP_39, TMP_40, TMP_41, TMP_42, TMP_43, TMP_44, TMP_45, TMP_46, TMP_47, TMP_48, TMP_49, TMP_50, TMP_51, TMP_52, TMP_53, TMP_54, TMP_55, TMP_56, TMP_57, TMP_58, TMP_59, TMP_61, TMP_62, TMP_63, TMP_64, TMP_65, TMP_66, TMP_67, TMP_68;

    def.length = nil;
    self.$include($scope.get('Comparable'));

    def.$$is_string = true;

    Opal.defn(self, '$__id__', TMP_1 = function $$__id__() {
      var self = this;

      return self.toString();
    }, TMP_1.$$arity = 0);

    Opal.alias(self, 'object_id', '__id__');

    Opal.defs(self, '$try_convert', TMP_2 = function $$try_convert(what) {
      var self = this;

      return $scope.get('Opal')['$coerce_to?'](what, $scope.get('String'), "to_str");
    }, TMP_2.$$arity = 1);

    Opal.defs(self, '$new', TMP_3 = function(str) {
      var self = this;

      if (str == null) {
        str = "";
      }
      str = $scope.get('Opal').$coerce_to(str, $scope.get('String'), "to_str");
      return new String(str);
    }, TMP_3.$$arity = -1);

    Opal.defn(self, '$initialize', TMP_4 = function $$initialize(str) {
      var self = this;

      
      if (str === undefined) {
        return self;
      }
    
      return self.$raise($scope.get('NotImplementedError'), "Mutable strings are not supported in Opal.");
    }, TMP_4.$$arity = -1);

    Opal.defn(self, '$%', TMP_5 = function(data) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](data)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($a = self).$format.apply($a, [self].concat(Opal.to_a(data)))
        } else {
        return self.$format(self, data)
      };
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$*', TMP_6 = function(count) {
      var self = this;

      
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative argument")
      }

      if (count === 0) {
        return '';
      }

      var result = '',
          string = self.toString();

      // All credit for the bit-twiddling magic code below goes to Mozilla
      // polyfill implementation of String.prototype.repeat() posted here:
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/repeat

      if (string.length * count >= 1 << 28) {
        self.$raise($scope.get('RangeError'), "multiply count must not overflow maximum string size")
      }

      for (;;) {
        if ((count & 1) === 1) {
          result += string;
        }
        count >>>= 1;
        if (count === 0) {
          break;
        }
        string += string;
      }

      return result;
    ;
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$+', TMP_7 = function(other) {
      var self = this;

      other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str");
      return self + other.$to_s();
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$<=>', TMP_8 = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_str().$to_s();
        return self > other ? 1 : (self < other ? -1 : 0);
        } else {
        
        var cmp = other['$<=>'](self);

        if (cmp === nil) {
          return nil;
        }
        else {
          return cmp > 0 ? -1 : (cmp < 0 ? 1 : 0);
        }
      ;
      };
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$==', TMP_9 = function(other) {
      var self = this;

      
      if (other.$$is_string) {
        return self.toString() === other.toString();
      }
      if ($scope.get('Opal')['$respond_to?'](other, "to_str")) {
        return other['$=='](self);
      }
      return false;
    ;
    }, TMP_9.$$arity = 1);

    Opal.alias(self, 'eql?', '==');

    Opal.alias(self, '===', '==');

    Opal.defn(self, '$=~', TMP_10 = function(other) {
      var self = this;

      
      if (other.$$is_string) {
        self.$raise($scope.get('TypeError'), "type mismatch: String given");
      }

      return other['$=~'](self);
    ;
    }, TMP_10.$$arity = 1);

    Opal.defn(self, '$[]', TMP_11 = function(index, length) {
      var self = this;

      
      var size = self.length, exclude;

      if (index.$$is_range) {
        exclude = index.exclude;
        length  = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");
        index   = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int");

        if (Math.abs(index) > size) {
          return nil;
        }

        if (index < 0) {
          index += size;
        }

        if (length < 0) {
          length += size;
        }

        if (!exclude) {
          length += 1;
        }

        length = length - index;

        if (length < 0) {
          length = 0;
        }

        return self.substr(index, length);
      }


      if (index.$$is_string) {
        if (length != null) {
          self.$raise($scope.get('TypeError'))
        }
        return self.indexOf(index) !== -1 ? index : nil;
      }


      if (index.$$is_regexp) {
        var match = self.match(index);

        if (match === null) {
          $gvars["~"] = nil
          return nil;
        }

        $gvars["~"] = $scope.get('MatchData').$new(index, match)

        if (length == null) {
          return match[0];
        }

        length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

        if (length < 0 && -length < match.length) {
          return match[length += match.length];
        }

        if (length >= 0 && length < match.length) {
          return match[length];
        }

        return nil;
      }


      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += size;
      }

      if (length == null) {
        if (index >= size || index < 0) {
          return nil;
        }
        return self.substr(index, 1);
      }

      length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

      if (length < 0) {
        return nil;
      }

      if (index > size || index < 0) {
        return nil;
      }

      return self.substr(index, length);
    
    }, TMP_11.$$arity = -2);

    Opal.alias(self, 'byteslice', '[]');

    Opal.defn(self, '$capitalize', TMP_12 = function $$capitalize() {
      var self = this;

      return self.charAt(0).toUpperCase() + self.substr(1).toLowerCase();
    }, TMP_12.$$arity = 0);

    Opal.defn(self, '$casecmp', TMP_13 = function $$casecmp(other) {
      var self = this;

      other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str").$to_s();
      
      var ascii_only = /^[\x00-\x7F]*$/;
      if (ascii_only.test(self) && ascii_only.test(other)) {
        self = self.toLowerCase();
        other = other.toLowerCase();
      }
    
      return self['$<=>'](other);
    }, TMP_13.$$arity = 1);

    Opal.defn(self, '$center', TMP_14 = function $$center(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " ";
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var ljustified = self.$ljust($rb_divide(($rb_plus(width, self.length)), 2).$ceil(), padstr),
          rjustified = self.$rjust($rb_divide(($rb_plus(width, self.length)), 2).$floor(), padstr);

      return rjustified + ljustified.slice(self.length);
    ;
    }, TMP_14.$$arity = -2);

    Opal.defn(self, '$chars', TMP_15 = function $$chars() {
      var $a, $b, self = this, $iter = TMP_15.$$p, block = $iter || nil;

      TMP_15.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return self.$each_char().$to_a()
      };
      return ($a = ($b = self).$each_char, $a.$$p = block.$to_proc(), $a).call($b);
    }, TMP_15.$$arity = 0);

    Opal.defn(self, '$chomp', TMP_16 = function $$chomp(separator) {
      var $a, self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"];
      }
      if ((($a = separator === nil || self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self};
      separator = $scope.get('Opal')['$coerce_to!'](separator, $scope.get('String'), "to_str").$to_s();
      
      if (separator === "\n") {
        return self.replace(/\r?\n?$/, '');
      }
      else if (separator === "") {
        return self.replace(/(\r?\n)+$/, '');
      }
      else if (self.length > separator.length) {
        var tail = self.substr(self.length - separator.length, separator.length);

        if (tail === separator) {
          return self.substr(0, self.length - separator.length);
        }
      }
    
      return self;
    }, TMP_16.$$arity = -1);

    Opal.defn(self, '$chop', TMP_17 = function $$chop() {
      var self = this;

      
      var length = self.length;

      if (length <= 1) {
        return "";
      }

      if (self.charAt(length - 1) === "\n" && self.charAt(length - 2) === "\r") {
        return self.substr(0, length - 2);
      }
      else {
        return self.substr(0, length - 1);
      }
    
    }, TMP_17.$$arity = 0);

    Opal.defn(self, '$chr', TMP_18 = function $$chr() {
      var self = this;

      return self.charAt(0);
    }, TMP_18.$$arity = 0);

    Opal.defn(self, '$clone', TMP_19 = function $$clone() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$copy_singleton_methods(self);
      copy.$initialize_clone(self);
      return copy;
    }, TMP_19.$$arity = 0);

    Opal.defn(self, '$dup', TMP_20 = function $$dup() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_dup(self);
      return copy;
    }, TMP_20.$$arity = 0);

    Opal.defn(self, '$count', TMP_21 = function $$count($a_rest) {
      var self = this, sets;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      sets = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        sets[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      if (sets.length === 0) {
        self.$raise($scope.get('ArgumentError'), "ArgumentError: wrong number of arguments (0 for 1+)")
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return 0;
      }
      return self.length - self.replace(new RegExp(char_class, 'g'), '').length;
    ;
    }, TMP_21.$$arity = -1);

    Opal.defn(self, '$delete', TMP_22 = function($a_rest) {
      var self = this, sets;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      sets = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        sets[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      if (sets.length === 0) {
        self.$raise($scope.get('ArgumentError'), "ArgumentError: wrong number of arguments (0 for 1+)")
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return self;
      }
      return self.replace(new RegExp(char_class, 'g'), '');
    ;
    }, TMP_22.$$arity = -1);

    Opal.defn(self, '$downcase', TMP_23 = function $$downcase() {
      var self = this;

      return self.toLowerCase();
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$each_char', TMP_24 = function $$each_char() {
      var $a, $b, TMP_25, self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_25 = function(){var self = TMP_25.$$s || this;

        return self.$size()}, TMP_25.$$s = self, TMP_25.$$arity = 0, TMP_25), $a).call($b, "each_char")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        Opal.yield1(block, self.charAt(i));
      }
    
      return self;
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$each_line', TMP_26 = function $$each_line(separator) {
      var self = this, $iter = TMP_26.$$p, block = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"];
      }
      TMP_26.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_line", separator)
      };
      
      if (separator === nil) {
        Opal.yield1(block, self);

        return self;
      }

      separator = $scope.get('Opal').$coerce_to(separator, $scope.get('String'), "to_str")

      var a, i, n, length, chomped, trailing, splitted;

      if (separator.length === 0) {
        for (a = self.split(/(\n{2,})/), i = 0, n = a.length; i < n; i += 2) {
          if (a[i] || a[i + 1]) {
            Opal.yield1(block, (a[i] || "") + (a[i + 1] || ""));
          }
        }

        return self;
      }

      chomped  = self.$chomp(separator);
      trailing = self.length != chomped.length;
      splitted = chomped.split(separator);

      for (i = 0, length = splitted.length; i < length; i++) {
        if (i < length - 1 || trailing) {
          Opal.yield1(block, splitted[i] + separator);
        }
        else {
          Opal.yield1(block, splitted[i]);
        }
      }
    
      return self;
    }, TMP_26.$$arity = -1);

    Opal.defn(self, '$empty?', TMP_27 = function() {
      var self = this;

      return self.length === 0;
    }, TMP_27.$$arity = 0);

    Opal.defn(self, '$end_with?', TMP_28 = function($a_rest) {
      var self = this, suffixes;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      suffixes = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        suffixes[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = 0, length = suffixes.length; i < length; i++) {
        var suffix = $scope.get('Opal').$coerce_to(suffixes[i], $scope.get('String'), "to_str").$to_s();

        if (self.length >= suffix.length &&
            self.substr(self.length - suffix.length, suffix.length) == suffix) {
          return true;
        }
      }
    
      return false;
    }, TMP_28.$$arity = -1);

    Opal.alias(self, 'eql?', '==');

    Opal.alias(self, 'equal?', '===');

    Opal.defn(self, '$gsub', TMP_29 = function $$gsub(pattern, replacement) {
      var self = this, $iter = TMP_29.$$p, block = $iter || nil;

      TMP_29.$$p = null;
      
      if (replacement === undefined && block === nil) {
        return self.$enum_for("gsub", pattern);
      }

      var result = '', match_data = nil, index = 0, match, _replacement;

      if (pattern.$$is_regexp) {
        pattern = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      } else {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str");
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      }

      while (true) {
        match = pattern.exec(self);

        if (match === null) {
          $gvars["~"] = nil
          result += self.slice(index);
          break;
        }

        match_data = $scope.get('MatchData').$new(pattern, match);

        if (replacement === undefined) {
          _replacement = block(match[0]);
        }
        else if (replacement.$$is_hash) {
          _replacement = (replacement)['$[]'](match[0]).$to_s();
        }
        else {
          if (!replacement.$$is_string) {
            replacement = $scope.get('Opal').$coerce_to(replacement, $scope.get('String'), "to_str");
          }
          _replacement = replacement.replace(/([\\]+)([0-9+&`'])/g, function (original, slashes, command) {
            if (slashes.length % 2 === 0) {
              return original;
            }
            switch (command) {
            case "+":
              for (var i = match.length - 1; i > 0; i--) {
                if (match[i] !== undefined) {
                  return slashes.slice(1) + match[i];
                }
              }
              return '';
            case "&": return slashes.slice(1) + match[0];
            case "`": return slashes.slice(1) + self.slice(0, match.index);
            case "'": return slashes.slice(1) + self.slice(match.index + match[0].length);
            default:  return slashes.slice(1) + (match[command] || '');
            }
          }).replace(/\\\\/g, '\\');
        }

        if (pattern.lastIndex === match.index) {
          result += (_replacement + self.slice(index, match.index + 1))
          pattern.lastIndex += 1;
        }
        else {
          result += (self.slice(index, match.index) + _replacement)
        }
        index = pattern.lastIndex;
      }

      $gvars["~"] = match_data
      return result;
    ;
    }, TMP_29.$$arity = -2);

    Opal.defn(self, '$hash', TMP_30 = function $$hash() {
      var self = this;

      return self.toString();
    }, TMP_30.$$arity = 0);

    Opal.defn(self, '$hex', TMP_31 = function $$hex() {
      var self = this;

      return self.$to_i(16);
    }, TMP_31.$$arity = 0);

    Opal.defn(self, '$include?', TMP_32 = function(other) {
      var self = this;

      
      if (!other.$$is_string) {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str")
      }
      return self.indexOf(other) !== -1;
    ;
    }, TMP_32.$$arity = 1);

    Opal.defn(self, '$index', TMP_33 = function $$index(search, offset) {
      var self = this;

      
      var index,
          match,
          regex;

      if (offset === undefined) {
        offset = 0;
      } else {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int");
        if (offset < 0) {
          offset += self.length;
          if (offset < 0) {
            return nil;
          }
        }
      }

      if (search.$$is_regexp) {
        regex = new RegExp(search.source, 'gm' + (search.ignoreCase ? 'i' : ''));
        while (true) {
          match = regex.exec(self);
          if (match === null) {
            $gvars["~"] = nil;
            index = -1;
            break;
          }
          if (match.index >= offset) {
            $gvars["~"] = $scope.get('MatchData').$new(regex, match)
            index = match.index;
            break;
          }
          regex.lastIndex = match.index + 1;
        }
      } else {
        search = $scope.get('Opal').$coerce_to(search, $scope.get('String'), "to_str");
        if (search.length === 0 && offset > self.length) {
          index = -1;
        } else {
          index = self.indexOf(search, offset);
        }
      }

      return index === -1 ? nil : index;
    
    }, TMP_33.$$arity = -2);

    Opal.defn(self, '$inspect', TMP_34 = function $$inspect() {
      var self = this;

      
      var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          meta = {
            '\u0007': '\\a',
            '\u001b': '\\e',
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '\v': '\\v',
            '"' : '\\"',
            '\\': '\\\\'
          },
          escaped = self.replace(escapable, function (chr) {
            return meta[chr] || '\\u' + ('0000' + chr.charCodeAt(0).toString(16).toUpperCase()).slice(-4);
          });
      return '"' + escaped.replace(/\#[\$\@\{]/g, '\\$&') + '"';
    
    }, TMP_34.$$arity = 0);

    Opal.defn(self, '$intern', TMP_35 = function $$intern() {
      var self = this;

      return self;
    }, TMP_35.$$arity = 0);

    Opal.defn(self, '$lines', TMP_36 = function $$lines(separator) {
      var $a, $b, self = this, $iter = TMP_36.$$p, block = $iter || nil, e = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"];
      }
      TMP_36.$$p = null;
      e = ($a = ($b = self).$each_line, $a.$$p = block.$to_proc(), $a).call($b, separator);
      if (block !== false && block !== nil && block != null) {
        return self
        } else {
        return e.$to_a()
      };
    }, TMP_36.$$arity = -1);

    Opal.defn(self, '$length', TMP_37 = function $$length() {
      var self = this;

      return self.length;
    }, TMP_37.$$arity = 0);

    Opal.defn(self, '$ljust', TMP_38 = function $$ljust(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " ";
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var index  = -1,
          result = "";

      width -= self.length;

      while (++index < width) {
        result += padstr;
      }

      return self + result.slice(0, width);
    
    }, TMP_38.$$arity = -2);

    Opal.defn(self, '$lstrip', TMP_39 = function $$lstrip() {
      var self = this;

      return self.replace(/^\s*/, '');
    }, TMP_39.$$arity = 0);

    Opal.defn(self, '$match', TMP_40 = function $$match(pattern, pos) {
      var $a, $b, self = this, $iter = TMP_40.$$p, block = $iter || nil;

      TMP_40.$$p = null;
      if ((($a = ((($b = $scope.get('String')['$==='](pattern)) !== false && $b !== nil && $b != null) ? $b : pattern['$respond_to?']("to_str"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        pattern = $scope.get('Regexp').$new(pattern.$to_str())};
      if ((($a = $scope.get('Regexp')['$==='](pattern)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return ($a = ($b = pattern).$match, $a.$$p = block.$to_proc(), $a).call($b, self, pos);
    }, TMP_40.$$arity = -2);

    Opal.defn(self, '$next', TMP_41 = function $$next() {
      var self = this;

      
      var i = self.length;
      if (i === 0) {
        return '';
      }
      var result = self;
      var first_alphanum_char_index = self.search(/[a-zA-Z0-9]/);
      var carry = false;
      var code;
      while (i--) {
        code = self.charCodeAt(i);
        if ((code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122)) {
          switch (code) {
          case 57:
            carry = true;
            code = 48;
            break;
          case 90:
            carry = true;
            code = 65;
            break;
          case 122:
            carry = true;
            code = 97;
            break;
          default:
            carry = false;
            code += 1;
          }
        } else {
          if (first_alphanum_char_index === -1) {
            if (code === 255) {
              carry = true;
              code = 0;
            } else {
              carry = false;
              code += 1;
            }
          } else {
            carry = true;
          }
        }
        result = result.slice(0, i) + String.fromCharCode(code) + result.slice(i + 1);
        if (carry && (i === 0 || i === first_alphanum_char_index)) {
          switch (code) {
          case 65:
            break;
          case 97:
            break;
          default:
            code += 1;
          }
          if (i === 0) {
            result = String.fromCharCode(code) + result;
          } else {
            result = result.slice(0, i) + String.fromCharCode(code) + result.slice(i);
          }
          carry = false;
        }
        if (!carry) {
          break;
        }
      }
      return result;
    
    }, TMP_41.$$arity = 0);

    Opal.defn(self, '$oct', TMP_42 = function $$oct() {
      var self = this;

      
      var result,
          string = self,
          radix = 8;

      if (/^\s*_/.test(string)) {
        return 0;
      }

      string = string.replace(/^(\s*[+-]?)(0[bodx]?)(.+)$/i, function (original, head, flag, tail) {
        switch (tail.charAt(0)) {
        case '+':
        case '-':
          return original;
        case '0':
          if (tail.charAt(1) === 'x' && flag === '0x') {
            return original;
          }
        }
        switch (flag) {
        case '0b':
          radix = 2;
          break;
        case '0':
        case '0o':
          radix = 8;
          break;
        case '0d':
          radix = 10;
          break;
        case '0x':
          radix = 16;
          break;
        }
        return head + tail;
      });

      result = parseInt(string.replace(/_(?!_)/g, ''), radix);
      return isNaN(result) ? 0 : result;
    
    }, TMP_42.$$arity = 0);

    Opal.defn(self, '$ord', TMP_43 = function $$ord() {
      var self = this;

      return self.charCodeAt(0);
    }, TMP_43.$$arity = 0);

    Opal.defn(self, '$partition', TMP_44 = function $$partition(sep) {
      var self = this;

      
      var i, m;

      if (sep.$$is_regexp) {
        m = sep.exec(self);
        if (m === null) {
          i = -1;
        } else {
          $scope.get('MatchData').$new(sep, m);
          sep = m[0];
          i = m.index;
        }
      } else {
        sep = $scope.get('Opal').$coerce_to(sep, $scope.get('String'), "to_str");
        i = self.indexOf(sep);
      }

      if (i === -1) {
        return [self, '', ''];
      }

      return [
        self.slice(0, i),
        self.slice(i, i + sep.length),
        self.slice(i + sep.length)
      ];
    
    }, TMP_44.$$arity = 1);

    Opal.defn(self, '$reverse', TMP_45 = function $$reverse() {
      var self = this;

      return self.split('').reverse().join('');
    }, TMP_45.$$arity = 0);

    Opal.defn(self, '$rindex', TMP_46 = function $$rindex(search, offset) {
      var self = this;

      
      var i, m, r, _m;

      if (offset === undefined) {
        offset = self.length;
      } else {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int");
        if (offset < 0) {
          offset += self.length;
          if (offset < 0) {
            return nil;
          }
        }
      }

      if (search.$$is_regexp) {
        m = null;
        r = new RegExp(search.source, 'gm' + (search.ignoreCase ? 'i' : ''));
        while (true) {
          _m = r.exec(self);
          if (_m === null || _m.index > offset) {
            break;
          }
          m = _m;
          r.lastIndex = m.index + 1;
        }
        if (m === null) {
          $gvars["~"] = nil
          i = -1;
        } else {
          $scope.get('MatchData').$new(r, m);
          i = m.index;
        }
      } else {
        search = $scope.get('Opal').$coerce_to(search, $scope.get('String'), "to_str");
        i = self.lastIndexOf(search, offset);
      }

      return i === -1 ? nil : i;
    
    }, TMP_46.$$arity = -2);

    Opal.defn(self, '$rjust', TMP_47 = function $$rjust(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " ";
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var chars     = Math.floor(width - self.length),
          patterns  = Math.floor(chars / padstr.length),
          result    = Array(patterns + 1).join(padstr),
          remaining = chars - result.length;

      return result + padstr.slice(0, remaining) + self;
    
    }, TMP_47.$$arity = -2);

    Opal.defn(self, '$rpartition', TMP_48 = function $$rpartition(sep) {
      var self = this;

      
      var i, m, r, _m;

      if (sep.$$is_regexp) {
        m = null;
        r = new RegExp(sep.source, 'gm' + (sep.ignoreCase ? 'i' : ''));

        while (true) {
          _m = r.exec(self);
          if (_m === null) {
            break;
          }
          m = _m;
          r.lastIndex = m.index + 1;
        }

        if (m === null) {
          i = -1;
        } else {
          $scope.get('MatchData').$new(r, m);
          sep = m[0];
          i = m.index;
        }

      } else {
        sep = $scope.get('Opal').$coerce_to(sep, $scope.get('String'), "to_str");
        i = self.lastIndexOf(sep);
      }

      if (i === -1) {
        return ['', '', self];
      }

      return [
        self.slice(0, i),
        self.slice(i, i + sep.length),
        self.slice(i + sep.length)
      ];
    
    }, TMP_48.$$arity = 1);

    Opal.defn(self, '$rstrip', TMP_49 = function $$rstrip() {
      var self = this;

      return self.replace(/[\s\u0000]*$/, '');
    }, TMP_49.$$arity = 0);

    Opal.defn(self, '$scan', TMP_50 = function $$scan(pattern) {
      var self = this, $iter = TMP_50.$$p, block = $iter || nil;

      TMP_50.$$p = null;
      
      var result = [],
          match_data = nil,
          match;

      if (pattern.$$is_regexp) {
        pattern = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      } else {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str");
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
      }

      while ((match = pattern.exec(self)) != null) {
        match_data = $scope.get('MatchData').$new(pattern, match);
        if (block === nil) {
          match.length == 1 ? result.push(match[0]) : result.push((match_data).$captures());
        } else {
          match.length == 1 ? block(match[0]) : block.call(self, (match_data).$captures());
        }
        if (pattern.lastIndex === match.index) {
          pattern.lastIndex += 1;
        }
      }

      $gvars["~"] = match_data

      return (block !== nil ? self : result);
    
    }, TMP_50.$$arity = 1);

    Opal.alias(self, 'size', 'length');

    Opal.alias(self, 'slice', '[]');

    Opal.defn(self, '$split', TMP_51 = function $$split(pattern, limit) {
      var $a, self = this;
      if ($gvars[";"] == null) $gvars[";"] = nil;

      
      if (self.length === 0) {
        return [];
      }

      if (limit === undefined) {
        limit = 0;
      } else {
        limit = $scope.get('Opal')['$coerce_to!'](limit, $scope.get('Integer'), "to_int");
        if (limit === 1) {
          return [self];
        }
      }

      if (pattern === undefined || pattern === nil) {
        pattern = ((($a = $gvars[";"]) !== false && $a !== nil && $a != null) ? $a : " ");
      }

      var result = [],
          string = self.toString(),
          index = 0,
          match,
          i;

      if (pattern.$$is_regexp) {
        pattern = new RegExp(pattern.source, 'gm' + (pattern.ignoreCase ? 'i' : ''));
      } else {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str").$to_s();
        if (pattern === ' ') {
          pattern = /\s+/gm;
          string = string.replace(/^\s+/, '');
        } else {
          pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gm');
        }
      }

      result = string.split(pattern);

      if (result.length === 1 && result[0] === string) {
        return result;
      }

      while ((i = result.indexOf(undefined)) !== -1) {
        result.splice(i, 1);
      }

      if (limit === 0) {
        while (result[result.length - 1] === '') {
          result.length -= 1;
        }
        return result;
      }

      match = pattern.exec(string);

      if (limit < 0) {
        if (match !== null && match[0] === '' && pattern.source.indexOf('(?=') === -1) {
          for (i = 0; i < match.length; i++) {
            result.push('');
          }
        }
        return result;
      }

      if (match !== null && match[0] === '') {
        result.splice(limit - 1, result.length - 1, result.slice(limit - 1).join(''));
        return result;
      }

      if (limit >= result.length) {
        return result;
      }

      i = 0;
      while (match !== null) {
        i++;
        index = pattern.lastIndex;
        if (i + 1 === limit) {
          break;
        }
        match = pattern.exec(string);
      }
      result.splice(limit - 1, result.length - 1, string.slice(index));
      return result;
    
    }, TMP_51.$$arity = -1);

    Opal.defn(self, '$squeeze', TMP_52 = function $$squeeze($a_rest) {
      var self = this, sets;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      sets = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        sets[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      if (sets.length === 0) {
        return self.replace(/(.)\1+/g, '$1');
      }
      var char_class = char_class_from_char_sets(sets);
      if (char_class === null) {
        return self;
      }
      return self.replace(new RegExp('(' + char_class + ')\\1+', 'g'), '$1');
    
    }, TMP_52.$$arity = -1);

    Opal.defn(self, '$start_with?', TMP_53 = function($a_rest) {
      var self = this, prefixes;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      prefixes = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        prefixes[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = 0, length = prefixes.length; i < length; i++) {
        var prefix = $scope.get('Opal').$coerce_to(prefixes[i], $scope.get('String'), "to_str").$to_s();

        if (self.indexOf(prefix) === 0) {
          return true;
        }
      }

      return false;
    
    }, TMP_53.$$arity = -1);

    Opal.defn(self, '$strip', TMP_54 = function $$strip() {
      var self = this;

      return self.replace(/^\s*/, '').replace(/[\s\u0000]*$/, '');
    }, TMP_54.$$arity = 0);

    Opal.defn(self, '$sub', TMP_55 = function $$sub(pattern, replacement) {
      var self = this, $iter = TMP_55.$$p, block = $iter || nil;

      TMP_55.$$p = null;
      
      if (!pattern.$$is_regexp) {
        pattern = $scope.get('Opal').$coerce_to(pattern, $scope.get('String'), "to_str");
        pattern = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }

      var result = pattern.exec(self);

      if (result === null) {
        $gvars["~"] = nil
        return self.toString();
      }

      $scope.get('MatchData').$new(pattern, result)

      if (replacement === undefined) {
        if (block === nil) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (1 for 2)")
        }
        return self.slice(0, result.index) + block(result[0]) + self.slice(result.index + result[0].length);
      }

      if (replacement.$$is_hash) {
        return self.slice(0, result.index) + (replacement)['$[]'](result[0]).$to_s() + self.slice(result.index + result[0].length);
      }

      replacement = $scope.get('Opal').$coerce_to(replacement, $scope.get('String'), "to_str");

      replacement = replacement.replace(/([\\]+)([0-9+&`'])/g, function (original, slashes, command) {
        if (slashes.length % 2 === 0) {
          return original;
        }
        switch (command) {
        case "+":
          for (var i = result.length - 1; i > 0; i--) {
            if (result[i] !== undefined) {
              return slashes.slice(1) + result[i];
            }
          }
          return '';
        case "&": return slashes.slice(1) + result[0];
        case "`": return slashes.slice(1) + self.slice(0, result.index);
        case "'": return slashes.slice(1) + self.slice(result.index + result[0].length);
        default:  return slashes.slice(1) + (result[command] || '');
        }
      }).replace(/\\\\/g, '\\');

      return self.slice(0, result.index) + replacement + self.slice(result.index + result[0].length);
    ;
    }, TMP_55.$$arity = -2);

    Opal.alias(self, 'succ', 'next');

    Opal.defn(self, '$sum', TMP_56 = function $$sum(n) {
      var self = this;

      if (n == null) {
        n = 16;
      }
      
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");

      var result = 0,
          length = self.length,
          i = 0;

      for (; i < length; i++) {
        result += self.charCodeAt(i);
      }

      if (n <= 0) {
        return result;
      }

      return result & (Math.pow(2, n) - 1);
    ;
    }, TMP_56.$$arity = -1);

    Opal.defn(self, '$swapcase', TMP_57 = function $$swapcase() {
      var self = this;

      
      var str = self.replace(/([a-z]+)|([A-Z]+)/g, function($0,$1,$2) {
        return $1 ? $0.toUpperCase() : $0.toLowerCase();
      });

      if (self.constructor === String) {
        return str;
      }

      return self.$class().$new(str);
    
    }, TMP_57.$$arity = 0);

    Opal.defn(self, '$to_f', TMP_58 = function $$to_f() {
      var self = this;

      
      if (self.charAt(0) === '_') {
        return 0;
      }

      var result = parseFloat(self.replace(/_/g, ''));

      if (isNaN(result) || result == Infinity || result == -Infinity) {
        return 0;
      }
      else {
        return result;
      }
    
    }, TMP_58.$$arity = 0);

    Opal.defn(self, '$to_i', TMP_59 = function $$to_i(base) {
      var self = this;

      if (base == null) {
        base = 10;
      }
      
      var result,
          string = self.toLowerCase(),
          radix = $scope.get('Opal').$coerce_to(base, $scope.get('Integer'), "to_int");

      if (radix === 1 || radix < 0 || radix > 36) {
        self.$raise($scope.get('ArgumentError'), "invalid radix " + (radix))
      }

      if (/^\s*_/.test(string)) {
        return 0;
      }

      string = string.replace(/^(\s*[+-]?)(0[bodx]?)(.+)$/, function (original, head, flag, tail) {
        switch (tail.charAt(0)) {
        case '+':
        case '-':
          return original;
        case '0':
          if (tail.charAt(1) === 'x' && flag === '0x' && (radix === 0 || radix === 16)) {
            return original;
          }
        }
        switch (flag) {
        case '0b':
          if (radix === 0 || radix === 2) {
            radix = 2;
            return head + tail;
          }
          break;
        case '0':
        case '0o':
          if (radix === 0 || radix === 8) {
            radix = 8;
            return head + tail;
          }
          break;
        case '0d':
          if (radix === 0 || radix === 10) {
            radix = 10;
            return head + tail;
          }
          break;
        case '0x':
          if (radix === 0 || radix === 16) {
            radix = 16;
            return head + tail;
          }
          break;
        }
        return original
      });

      result = parseInt(string.replace(/_(?!_)/g, ''), radix);
      return isNaN(result) ? 0 : result;
    ;
    }, TMP_59.$$arity = -1);

    Opal.defn(self, '$to_proc', TMP_61 = function $$to_proc() {
      var $a, $b, TMP_60, self = this, sym = nil;

      sym = self;
      return ($a = ($b = self).$proc, $a.$$p = (TMP_60 = function($c_rest){var self = TMP_60.$$s || this, block, args, $d, $e, obj = nil;

        block = TMP_60.$$p || nil, TMP_60.$$p = null;
        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
      if ((($d = args['$empty?']()) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
          self.$raise($scope.get('ArgumentError'), "no receiver given")};
        obj = args.$shift();
        return ($d = ($e = obj).$__send__, $d.$$p = block.$to_proc(), $d).apply($e, [sym].concat(Opal.to_a(args)));}, TMP_60.$$s = self, TMP_60.$$arity = -1, TMP_60), $a).call($b);
    }, TMP_61.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_62 = function $$to_s() {
      var self = this;

      return self.toString();
    }, TMP_62.$$arity = 0);

    Opal.alias(self, 'to_str', 'to_s');

    Opal.alias(self, 'to_sym', 'intern');

    Opal.defn(self, '$tr', TMP_63 = function $$tr(from, to) {
      var self = this;

      from = $scope.get('Opal').$coerce_to(from, $scope.get('String'), "to_str").$to_s();
      to = $scope.get('Opal').$coerce_to(to, $scope.get('String'), "to_str").$to_s();
      
      if (from.length == 0 || from === to) {
        return self;
      }

      var i, in_range, c, ch, start, end, length;
      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^' && from_chars.length > 1) {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      in_range = false;
      for (i = 0; i < from_length; i++) {
        ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          start = last_from.charCodeAt(0);
          end = ch.charCodeAt(0);
          if (start > end) {
            self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
          }
          for (c = start + 1; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          in_range = false;
          for (i = 0; i < to_length; i++) {
            ch = to_chars[i];
            if (last_to == null) {
              last_to = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              start = last_to.charCodeAt(0);
              end = ch.charCodeAt(0);
              if (start > end) {
                self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
              }
              for (c = start + 1; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_to = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }

      var new_str = ''
      for (i = 0, length = self.length; i < length; i++) {
        ch = self.charAt(i);
        var sub = subs[ch];
        if (inverse) {
          new_str += (sub == null ? global_sub : ch);
        }
        else {
          new_str += (sub != null ? sub : ch);
        }
      }
      return new_str;
    
    }, TMP_63.$$arity = 2);

    Opal.defn(self, '$tr_s', TMP_64 = function $$tr_s(from, to) {
      var self = this;

      from = $scope.get('Opal').$coerce_to(from, $scope.get('String'), "to_str").$to_s();
      to = $scope.get('Opal').$coerce_to(to, $scope.get('String'), "to_str").$to_s();
      
      if (from.length == 0) {
        return self;
      }

      var i, in_range, c, ch, start, end, length;
      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^' && from_chars.length > 1) {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      in_range = false;
      for (i = 0; i < from_length; i++) {
        ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          start = last_from.charCodeAt(0);
          end = ch.charCodeAt(0);
          if (start > end) {
            self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
          }
          for (c = start + 1; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          in_range = false;
          for (i = 0; i < to_length; i++) {
            ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              start = last_from.charCodeAt(0);
              end = ch.charCodeAt(0);
              if (start > end) {
                self.$raise($scope.get('ArgumentError'), "invalid range \"" + (String.fromCharCode(start)) + "-" + (String.fromCharCode(end)) + "\" in string transliteration")
              }
              for (c = start + 1; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }
      var new_str = ''
      var last_substitute = null
      for (i = 0, length = self.length; i < length; i++) {
        ch = self.charAt(i);
        var sub = subs[ch]
        if (inverse) {
          if (sub == null) {
            if (last_substitute == null) {
              new_str += global_sub;
              last_substitute = true;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
        else {
          if (sub != null) {
            if (last_substitute == null || last_substitute !== sub) {
              new_str += sub;
              last_substitute = sub;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
      }
      return new_str;
    
    }, TMP_64.$$arity = 2);

    Opal.defn(self, '$upcase', TMP_65 = function $$upcase() {
      var self = this;

      return self.toUpperCase();
    }, TMP_65.$$arity = 0);

    Opal.defn(self, '$upto', TMP_66 = function $$upto(stop, excl) {
      var self = this, $iter = TMP_66.$$p, block = $iter || nil;

      if (excl == null) {
        excl = false;
      }
      TMP_66.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("upto", stop, excl)
      };
      stop = $scope.get('Opal').$coerce_to(stop, $scope.get('String'), "to_str");
      
      var a, b, s = self.toString();

      if (s.length === 1 && stop.length === 1) {

        a = s.charCodeAt(0);
        b = stop.charCodeAt(0);

        while (a <= b) {
          if (excl && a === b) {
            break;
          }

          block(String.fromCharCode(a));

          a += 1;
        }

      } else if (parseInt(s, 10).toString() === s && parseInt(stop, 10).toString() === stop) {

        a = parseInt(s, 10);
        b = parseInt(stop, 10);

        while (a <= b) {
          if (excl && a === b) {
            break;
          }

          block(a.toString());

          a += 1;
        }

      } else {

        while (s.length <= stop.length && s <= stop) {
          if (excl && s === stop) {
            break;
          }

          block(s);

          s = (s).$succ();
        }

      }
      return self;
    
    }, TMP_66.$$arity = -2);

    
    function char_class_from_char_sets(sets) {
      function explode_sequences_in_character_set(set) {
        var result = '',
            i, len = set.length,
            curr_char,
            skip_next_dash,
            char_code_from,
            char_code_upto,
            char_code;
        for (i = 0; i < len; i++) {
          curr_char = set.charAt(i);
          if (curr_char === '-' && i > 0 && i < (len - 1) && !skip_next_dash) {
            char_code_from = set.charCodeAt(i - 1);
            char_code_upto = set.charCodeAt(i + 1);
            if (char_code_from > char_code_upto) {
              self.$raise($scope.get('ArgumentError'), "invalid range \"" + (char_code_from) + "-" + (char_code_upto) + "\" in string transliteration")
            }
            for (char_code = char_code_from + 1; char_code < char_code_upto + 1; char_code++) {
              result += String.fromCharCode(char_code);
            }
            skip_next_dash = true;
            i++;
          } else {
            skip_next_dash = (curr_char === '\\');
            result += curr_char;
          }
        }
        return result;
      }

      function intersection(setA, setB) {
        if (setA.length === 0) {
          return setB;
        }
        var result = '',
            i, len = setA.length,
            chr;
        for (i = 0; i < len; i++) {
          chr = setA.charAt(i);
          if (setB.indexOf(chr) !== -1) {
            result += chr;
          }
        }
        return result;
      }

      var i, len, set, neg, chr, tmp,
          pos_intersection = '',
          neg_intersection = '';

      for (i = 0, len = sets.length; i < len; i++) {
        set = $scope.get('Opal').$coerce_to(sets[i], $scope.get('String'), "to_str");
        neg = (set.charAt(0) === '^' && set.length > 1);
        set = explode_sequences_in_character_set(neg ? set.slice(1) : set);
        if (neg) {
          neg_intersection = intersection(neg_intersection, set);
        } else {
          pos_intersection = intersection(pos_intersection, set);
        }
      }

      if (pos_intersection.length > 0 && neg_intersection.length > 0) {
        tmp = '';
        for (i = 0, len = pos_intersection.length; i < len; i++) {
          chr = pos_intersection.charAt(i);
          if (neg_intersection.indexOf(chr) === -1) {
            tmp += chr;
          }
        }
        pos_intersection = tmp;
        neg_intersection = '';
      }

      if (pos_intersection.length > 0) {
        return '[' + $scope.get('Regexp').$escape(pos_intersection) + ']';
      }

      if (neg_intersection.length > 0) {
        return '[^' + $scope.get('Regexp').$escape(neg_intersection) + ']';
      }

      return null;
    }
  

    Opal.defn(self, '$instance_variables', TMP_67 = function $$instance_variables() {
      var self = this;

      return [];
    }, TMP_67.$$arity = 0);

    return (Opal.defs(self, '$_load', TMP_68 = function $$_load($a_rest) {
      var $b, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      return ($b = self).$new.apply($b, Opal.to_a(args));
    }, TMP_68.$$arity = -1), nil) && '_load';
  })($scope.base, String);
  return Opal.cdecl($scope, 'Symbol', $scope.get('String'));
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/enumerable"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$each', '$destructure', '$raise', '$new', '$yield', '$dup', '$enum_for', '$enumerator_size', '$flatten', '$map', '$proc', '$==', '$nil?', '$respond_to?', '$coerce_to!', '$>', '$*', '$coerce_to', '$try_convert', '$<', '$+', '$-', '$to_enum', '$ceil', '$/', '$size', '$===', '$<<', '$[]', '$[]=', '$inspect', '$__send__', '$<=>', '$first', '$reverse', '$sort', '$to_proc', '$compare', '$call', '$to_a', '$lambda', '$sort!', '$map!', '$zip']);
  return (function($base) {
    var $Enumerable, self = $Enumerable = $module($base, 'Enumerable');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_4, TMP_7, TMP_10, TMP_12, TMP_15, TMP_19, TMP_21, TMP_23, TMP_24, TMP_25, TMP_27, TMP_29, TMP_31, TMP_33, TMP_35, TMP_36, TMP_38, TMP_43, TMP_44, TMP_45, TMP_48, TMP_49, TMP_51, TMP_52, TMP_53, TMP_54, TMP_56, TMP_57, TMP_59, TMP_61, TMP_62, TMP_65, TMP_68, TMP_70, TMP_72, TMP_74, TMP_76, TMP_78, TMP_83, TMP_84, TMP_86;

    Opal.defn(self, '$all?', TMP_1 = function() {try {

      var $a, $b, TMP_2, $c, TMP_3, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if ((block !== nil)) {
        ($a = ($b = self).$each, $a.$$p = (TMP_2 = function($c_rest){var self = TMP_2.$$s || this, value, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($d = Opal.yieldX(block, Opal.to_a(value))) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            return nil
            } else {
            Opal.ret(false)
          }}, TMP_2.$$s = self, TMP_2.$$arity = -1, TMP_2), $a).call($b)
        } else {
        ($a = ($c = self).$each, $a.$$p = (TMP_3 = function($d_rest){var self = TMP_3.$$s || this, value, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($e = $scope.get('Opal').$destructure(value)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
            return nil
            } else {
            Opal.ret(false)
          }}, TMP_3.$$s = self, TMP_3.$$arity = -1, TMP_3), $a).call($c)
      };
      return true;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_1.$$arity = 0);

    Opal.defn(self, '$any?', TMP_4 = function() {try {

      var $a, $b, TMP_5, $c, TMP_6, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if ((block !== nil)) {
        ($a = ($b = self).$each, $a.$$p = (TMP_5 = function($c_rest){var self = TMP_5.$$s || this, value, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($d = Opal.yieldX(block, Opal.to_a(value))) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            Opal.ret(true)
            } else {
            return nil
          }}, TMP_5.$$s = self, TMP_5.$$arity = -1, TMP_5), $a).call($b)
        } else {
        ($a = ($c = self).$each, $a.$$p = (TMP_6 = function($d_rest){var self = TMP_6.$$s || this, value, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($e = $scope.get('Opal').$destructure(value)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
            Opal.ret(true)
            } else {
            return nil
          }}, TMP_6.$$s = self, TMP_6.$$arity = -1, TMP_6), $a).call($c)
      };
      return false;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_4.$$arity = 0);

    Opal.defn(self, '$chunk', TMP_7 = function $$chunk(state) {
      var $a, $b, TMP_8, self = this, $iter = TMP_7.$$p, original_block = $iter || nil;

      TMP_7.$$p = null;
      if (original_block !== false && original_block !== nil && original_block != null) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "no block given")
      };
      return ($a = ($b = Opal.get('Enumerator')).$new, $a.$$p = (TMP_8 = function(yielder){var self = TMP_8.$$s || this, $c, $d, TMP_9;
if (yielder == null) yielder = nil;
      
        var block, previous = nil, accumulate = [];

        if (state == undefined || state === nil) {
          block = original_block;
        } else {
          block = ($c = ($d = $scope.get('Proc')).$new, $c.$$p = (TMP_9 = function(val){var self = TMP_9.$$s || this;
if (val == null) val = nil;
        return original_block.$yield(val, state.$dup())}, TMP_9.$$s = self, TMP_9.$$arity = 1, TMP_9), $c).call($d)
        }

        function releaseAccumulate() {
          if (accumulate.length > 0) {
            yielder.$yield(previous, accumulate)
          }
        }

        self.$each.$$p = function(value) {
          var key = Opal.yield1(block, value);

          if (key === nil) {
            releaseAccumulate();
            accumulate = [];
            previous = nil;
          } else {
            if (previous === nil || previous === key) {
              accumulate.push(value);
            } else {
              releaseAccumulate();
              accumulate = [value];
            }

            previous = key;
          }
        }

        self.$each();

        releaseAccumulate();
      ;}, TMP_8.$$s = self, TMP_8.$$arity = 1, TMP_8), $a).call($b);
    }, TMP_7.$$arity = -1);

    Opal.defn(self, '$collect', TMP_10 = function $$collect() {
      var $a, $b, TMP_11, self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_11 = function(){var self = TMP_11.$$s || this;

        return self.$enumerator_size()}, TMP_11.$$s = self, TMP_11.$$arity = 0, TMP_11), $a).call($b, "collect")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var value = Opal.yieldX(block, arguments);

        result.push(value);
      };

      self.$each();

      return result;
    
    }, TMP_10.$$arity = 0);

    Opal.defn(self, '$collect_concat', TMP_12 = function $$collect_concat() {
      var $a, $b, TMP_13, $c, TMP_14, self = this, $iter = TMP_12.$$p, block = $iter || nil;

      TMP_12.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_13 = function(){var self = TMP_13.$$s || this;

        return self.$enumerator_size()}, TMP_13.$$s = self, TMP_13.$$arity = 0, TMP_13), $a).call($b, "collect_concat")
      };
      return ($a = ($c = self).$map, $a.$$p = (TMP_14 = function(item){var self = TMP_14.$$s || this;
if (item == null) item = nil;
      return Opal.yield1(block, item);}, TMP_14.$$s = self, TMP_14.$$arity = 1, TMP_14), $a).call($c).$flatten(1);
    }, TMP_12.$$arity = 0);

    Opal.defn(self, '$count', TMP_15 = function $$count(object) {
      var $a, $b, TMP_16, $c, TMP_17, $d, TMP_18, self = this, $iter = TMP_15.$$p, block = $iter || nil, result = nil;

      TMP_15.$$p = null;
      result = 0;
      if ((($a = object != null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        block = ($a = ($b = self).$proc, $a.$$p = (TMP_16 = function($c_rest){var self = TMP_16.$$s || this, args;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 0] = arguments[$arg_idx];
          }
        return $scope.get('Opal').$destructure(args)['$=='](object)}, TMP_16.$$s = self, TMP_16.$$arity = -1, TMP_16), $a).call($b)
      } else if ((($a = block['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        block = ($a = ($c = self).$proc, $a.$$p = (TMP_17 = function(){var self = TMP_17.$$s || this;

        return true}, TMP_17.$$s = self, TMP_17.$$arity = 0, TMP_17), $a).call($c)};
      ($a = ($d = self).$each, $a.$$p = (TMP_18 = function($e_rest){var self = TMP_18.$$s || this, args, $f;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
      if ((($f = Opal.yieldX(block, args)) !== nil && $f != null && (!$f.$$is_boolean || $f == true))) {
          return result++;
          } else {
          return nil
        }}, TMP_18.$$s = self, TMP_18.$$arity = -1, TMP_18), $a).call($d);
      return result;
    }, TMP_15.$$arity = -1);

    Opal.defn(self, '$cycle', TMP_19 = function $$cycle(n) {
      var $a, $b, TMP_20, self = this, $iter = TMP_19.$$p, block = $iter || nil;

      if (n == null) {
        n = nil;
      }
      TMP_19.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_20 = function(){var self = TMP_20.$$s || this, $c;

        if (n['$=='](nil)) {
            if ((($c = self['$respond_to?']("size")) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
              return (($scope.get('Float')).$$scope.get('INFINITY'))
              } else {
              return nil
            }
            } else {
            n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
            if ((($c = $rb_gt(n, 0)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
              return $rb_times(self.$enumerator_size(), n)
              } else {
              return 0
            };
          }}, TMP_20.$$s = self, TMP_20.$$arity = 0, TMP_20), $a).call($b, "cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
        if ((($a = n <= 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil};
      };
      
      var result,
          all = [], i, length, value;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        all.push(param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      if (all.length === 0) {
        return nil;
      }

      if (n === nil) {
        while (true) {
          for (i = 0, length = all.length; i < length; i++) {
            value = Opal.yield1(block, all[i]);
          }
        }
      }
      else {
        while (n > 1) {
          for (i = 0, length = all.length; i < length; i++) {
            value = Opal.yield1(block, all[i]);
          }

          n--;
        }
      }
    
    }, TMP_19.$$arity = -1);

    Opal.defn(self, '$detect', TMP_21 = function $$detect(ifnone) {try {

      var $a, $b, TMP_22, self = this, $iter = TMP_21.$$p, block = $iter || nil;

      TMP_21.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("detect", ifnone)
      };
      ($a = ($b = self).$each, $a.$$p = (TMP_22 = function($c_rest){var self = TMP_22.$$s || this, args, $d, value = nil;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
      value = $scope.get('Opal').$destructure(args);
        if ((($d = Opal.yield1(block, value)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
          Opal.ret(value)
          } else {
          return nil
        };}, TMP_22.$$s = self, TMP_22.$$arity = -1, TMP_22), $a).call($b);
      
      if (ifnone !== undefined) {
        if (typeof(ifnone) === 'function') {
          return ifnone();
        } else {
          return ifnone;
        }
      }
    
      return nil;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_21.$$arity = -1);

    Opal.defn(self, '$drop', TMP_23 = function $$drop(number) {
      var $a, self = this;

      number = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");
      if ((($a = number < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "attempt to drop negative size")};
      
      var result  = [],
          current = 0;

      self.$each.$$p = function() {
        if (number <= current) {
          result.push($scope.get('Opal').$destructure(arguments));
        }

        current++;
      };

      self.$each()

      return result;
    
    }, TMP_23.$$arity = 1);

    Opal.defn(self, '$drop_while', TMP_24 = function $$drop_while() {
      var $a, self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("drop_while")
      };
      
      var result   = [],
          dropping = true;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        if (dropping) {
          var value = Opal.yield1(block, param);

          if ((($a = value) === nil || $a == null || ($a.$$is_boolean && $a == false))) {
            dropping = false;
            result.push(param);
          }
        }
        else {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$each_cons', TMP_25 = function $$each_cons(n) {
      var $a, $b, TMP_26, self = this, $iter = TMP_25.$$p, block = $iter || nil;

      TMP_25.$$p = null;
      if ((($a = arguments.length != 1) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 1)")};
      n = $scope.get('Opal').$try_convert(n, $scope.get('Integer'), "to_int");
      if ((($a = n <= 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "invalid size")};
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_26 = function(){var self = TMP_26.$$s || this, $c, $d, enum_size = nil;

        enum_size = self.$enumerator_size();
          if ((($c = enum_size['$nil?']()) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return nil
          } else if ((($c = ((($d = enum_size['$=='](0)) !== false && $d !== nil && $d != null) ? $d : $rb_lt(enum_size, n))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return 0
            } else {
            return $rb_plus($rb_minus(enum_size, n), 1)
          };}, TMP_26.$$s = self, TMP_26.$$arity = 0, TMP_26), $a).call($b, "each_cons", n)
      };
      
      var buffer = [], result = nil;

      self.$each.$$p = function() {
        var element = $scope.get('Opal').$destructure(arguments);
        buffer.push(element);
        if (buffer.length > n) {
          buffer.shift();
        }
        if (buffer.length == n) {
          Opal.yield1(block, buffer.slice(0, n));
        }
      }

      self.$each();

      return result;
    
    }, TMP_25.$$arity = 1);

    Opal.defn(self, '$each_entry', TMP_27 = function $$each_entry($a_rest) {
      var $b, $c, TMP_28, self = this, data, $iter = TMP_27.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      data = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        data[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_27.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($b = ($c = self).$to_enum, $b.$$p = (TMP_28 = function(){var self = TMP_28.$$s || this;

        return self.$enumerator_size()}, TMP_28.$$s = self, TMP_28.$$arity = 0, TMP_28), $b).apply($c, ["each_entry"].concat(Opal.to_a(data)))
      };
      
      self.$each.$$p = function() {
        var item = $scope.get('Opal').$destructure(arguments);

        Opal.yield1(block, item);
      }

      self.$each.apply(self, data);

      return self;
    ;
    }, TMP_27.$$arity = -1);

    Opal.defn(self, '$each_slice', TMP_29 = function $$each_slice(n) {
      var $a, $b, TMP_30, self = this, $iter = TMP_29.$$p, block = $iter || nil;

      TMP_29.$$p = null;
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
      if ((($a = n <= 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "invalid slice size")};
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_30 = function(){var self = TMP_30.$$s || this, $c;

        if ((($c = self['$respond_to?']("size")) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return ($rb_divide(self.$size(), n)).$ceil()
            } else {
            return nil
          }}, TMP_30.$$s = self, TMP_30.$$arity = 0, TMP_30), $a).call($b, "each_slice", n)
      };
      
      var result,
          slice = []

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        slice.push(param);

        if (slice.length === n) {
          Opal.yield1(block, slice);
          slice = [];
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }

      // our "last" group, if smaller than n then won't have been yielded
      if (slice.length > 0) {
        Opal.yield1(block, slice);
      }
    ;
      return nil;
    }, TMP_29.$$arity = 1);

    Opal.defn(self, '$each_with_index', TMP_31 = function $$each_with_index($a_rest) {
      var $b, $c, TMP_32, self = this, args, $iter = TMP_31.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_31.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($b = ($c = self).$enum_for, $b.$$p = (TMP_32 = function(){var self = TMP_32.$$s || this;

        return self.$enumerator_size()}, TMP_32.$$s = self, TMP_32.$$arity = 0, TMP_32), $b).apply($c, ["each_with_index"].concat(Opal.to_a(args)))
      };
      
      var result,
          index = 0;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        block(param, index);

        index++;
      };

      self.$each.apply(self, args);

      if (result !== undefined) {
        return result;
      }
    
      return self;
    }, TMP_31.$$arity = -1);

    Opal.defn(self, '$each_with_object', TMP_33 = function $$each_with_object(object) {
      var $a, $b, TMP_34, self = this, $iter = TMP_33.$$p, block = $iter || nil;

      TMP_33.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_34 = function(){var self = TMP_34.$$s || this;

        return self.$enumerator_size()}, TMP_34.$$s = self, TMP_34.$$arity = 0, TMP_34), $a).call($b, "each_with_object", object)
      };
      
      var result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        block(param, object);
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return object;
    }, TMP_33.$$arity = 1);

    Opal.defn(self, '$entries', TMP_35 = function $$entries($a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var result = [];

      self.$each.$$p = function() {
        result.push($scope.get('Opal').$destructure(arguments));
      };

      self.$each.apply(self, args);

      return result;
    
    }, TMP_35.$$arity = -1);

    Opal.alias(self, 'find', 'detect');

    Opal.defn(self, '$find_all', TMP_36 = function $$find_all() {
      var $a, $b, TMP_37, self = this, $iter = TMP_36.$$p, block = $iter || nil;

      TMP_36.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_37 = function(){var self = TMP_37.$$s || this;

        return self.$enumerator_size()}, TMP_37.$$s = self, TMP_37.$$arity = 0, TMP_37), $a).call($b, "find_all")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if ((($a = value) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    }, TMP_36.$$arity = 0);

    Opal.defn(self, '$find_index', TMP_38 = function $$find_index(object) {try {

      var $a, $b, TMP_39, $c, TMP_40, self = this, $iter = TMP_38.$$p, block = $iter || nil, index = nil;

      TMP_38.$$p = null;
      if ((($a = object === undefined && block === nil) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$enum_for("find_index")};
      index = 0;
      if ((($a = object != null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        ($a = ($b = self).$each, $a.$$p = (TMP_39 = function($c_rest){var self = TMP_39.$$s || this, value;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ($scope.get('Opal').$destructure(value)['$=='](object)) {
            Opal.ret(index)};
          return index += 1;}, TMP_39.$$s = self, TMP_39.$$arity = -1, TMP_39), $a).call($b)
        } else {
        ($a = ($c = self).$each, $a.$$p = (TMP_40 = function($d_rest){var self = TMP_40.$$s || this, value, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($e = Opal.yieldX(block, Opal.to_a(value))) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
            Opal.ret(index)};
          return index += 1;}, TMP_40.$$s = self, TMP_40.$$arity = -1, TMP_40), $a).call($c)
      };
      return nil;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_38.$$arity = -1);

    Opal.defn(self, '$first', TMP_43 = function $$first(number) {try {

      var $a, $b, TMP_41, $c, TMP_42, self = this, result = nil, current = nil;

      if ((($a = number === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($a = ($b = self).$each, $a.$$p = (TMP_41 = function(value){var self = TMP_41.$$s || this;
if (value == null) value = nil;
        Opal.ret(value)}, TMP_41.$$s = self, TMP_41.$$arity = 1, TMP_41), $a).call($b)
        } else {
        result = [];
        number = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");
        if ((($a = number < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "attempt to take negative size")};
        if ((($a = number == 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return []};
        current = 0;
        ($a = ($c = self).$each, $a.$$p = (TMP_42 = function($d_rest){var self = TMP_42.$$s || this, args, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 0] = arguments[$arg_idx];
          }
        result.push($scope.get('Opal').$destructure(args));
          if ((($e = number <= ++current) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
            Opal.ret(result)
            } else {
            return nil
          };}, TMP_42.$$s = self, TMP_42.$$arity = -1, TMP_42), $a).call($c);
        return result;
      };
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_43.$$arity = -1);

    Opal.alias(self, 'flat_map', 'collect_concat');

    Opal.defn(self, '$grep', TMP_44 = function $$grep(pattern) {
      var $a, self = this, $iter = TMP_44.$$p, block = $iter || nil;

      TMP_44.$$p = null;
      
      var result = [];

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            value = Opal.yield1(block, param);

            result.push(value);
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            result.push(param);
          }
        };
      }

      self.$each();

      return result;
    ;
    }, TMP_44.$$arity = 1);

    Opal.defn(self, '$group_by', TMP_45 = function $$group_by() {
      var $a, $b, TMP_46, $c, $d, self = this, $iter = TMP_45.$$p, block = $iter || nil, hash = nil;

      TMP_45.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_46 = function(){var self = TMP_46.$$s || this;

        return self.$enumerator_size()}, TMP_46.$$s = self, TMP_46.$$arity = 0, TMP_46), $a).call($b, "group_by")
      };
      hash = $scope.get('Hash').$new();
      
      var result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        (($a = value, $c = hash, ((($d = $c['$[]']($a)) !== false && $d !== nil && $d != null) ? $d : $c['$[]=']($a, []))))['$<<'](param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return hash;
    }, TMP_45.$$arity = 0);

    Opal.defn(self, '$include?', TMP_48 = function(obj) {try {

      var $a, $b, TMP_47, self = this;

      ($a = ($b = self).$each, $a.$$p = (TMP_47 = function($c_rest){var self = TMP_47.$$s || this, args;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
      if ($scope.get('Opal').$destructure(args)['$=='](obj)) {
          Opal.ret(true)
          } else {
          return nil
        }}, TMP_47.$$s = self, TMP_47.$$arity = -1, TMP_47), $a).call($b);
      return false;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_48.$$arity = 1);

    Opal.defn(self, '$inject', TMP_49 = function $$inject(object, sym) {
      var self = this, $iter = TMP_49.$$p, block = $iter || nil;

      TMP_49.$$p = null;
      
      var result = object;

      if (block !== nil && sym === undefined) {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          value = Opal.yieldX(block, [result, value]);

          result = value;
        };
      }
      else {
        if (sym === undefined) {
          if (!$scope.get('Symbol')['$==='](object)) {
            self.$raise($scope.get('TypeError'), "" + (object.$inspect()) + " is not a Symbol");
          }

          sym    = object;
          result = undefined;
        }

        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          result = (result).$__send__(sym, value);
        };
      }

      self.$each();

      return result == undefined ? nil : result;
    ;
    }, TMP_49.$$arity = -1);

    Opal.defn(self, '$lazy', TMP_51 = function $$lazy() {
      var $a, $b, TMP_50, self = this;

      return ($a = ($b = (($scope.get('Enumerator')).$$scope.get('Lazy'))).$new, $a.$$p = (TMP_50 = function(enum$, $c_rest){var self = TMP_50.$$s || this, args, $d;

        var $args_len = arguments.length, $rest_len = $args_len - 1;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 1] = arguments[$arg_idx];
        }if (enum$ == null) enum$ = nil;
      return ($d = enum$).$yield.apply($d, Opal.to_a(args))}, TMP_50.$$s = self, TMP_50.$$arity = -2, TMP_50), $a).call($b, self, self.$enumerator_size());
    }, TMP_51.$$arity = 0);

    Opal.defn(self, '$enumerator_size', TMP_52 = function $$enumerator_size() {
      var $a, self = this;

      if ((($a = self['$respond_to?']("size")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$size()
        } else {
        return nil
      };
    }, TMP_52.$$arity = 0);

    Opal.alias(self, 'map', 'collect');

    Opal.defn(self, '$max', TMP_53 = function $$max(n) {
      var $a, $b, self = this, $iter = TMP_53.$$p, block = $iter || nil;

      TMP_53.$$p = null;
      
      if (n === undefined || n === nil) {
        var result, value;

        self.$each.$$p = function() {
          var item = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = item;
            return;
          }

          if (block !== nil) {
            value = Opal.yieldX(block, [item, result]);
          } else {
            value = (item)['$<=>'](result);
          }

          if (value === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed");
          }

          if (value > 0) {
            result = item;
          }
        }

        self.$each();

        if (result === undefined) {
          return nil;
        } else {
          return result;
        }
      }
    
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
      return ($a = ($b = self).$sort, $a.$$p = block.$to_proc(), $a).call($b).$reverse().$first(n);
    }, TMP_53.$$arity = -1);

    Opal.defn(self, '$max_by', TMP_54 = function $$max_by() {
      var $a, $b, TMP_55, self = this, $iter = TMP_54.$$p, block = $iter || nil;

      TMP_54.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_55 = function(){var self = TMP_55.$$s || this;

        return self.$enumerator_size()}, TMP_55.$$s = self, TMP_55.$$arity = 0, TMP_55), $a).call($b, "max_by")
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if ((value)['$<=>'](by) > 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    }, TMP_54.$$arity = 0);

    Opal.alias(self, 'member?', 'include?');

    Opal.defn(self, '$min', TMP_56 = function $$min() {
      var self = this, $iter = TMP_56.$$p, block = $iter || nil;

      TMP_56.$$p = null;
      
      var result;

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed");
          }

          if (value < 0) {
            result = param;
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ($scope.get('Opal').$compare(param, result) < 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    }, TMP_56.$$arity = 0);

    Opal.defn(self, '$min_by', TMP_57 = function $$min_by() {
      var $a, $b, TMP_58, self = this, $iter = TMP_57.$$p, block = $iter || nil;

      TMP_57.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_58 = function(){var self = TMP_58.$$s || this;

        return self.$enumerator_size()}, TMP_58.$$s = self, TMP_58.$$arity = 0, TMP_58), $a).call($b, "min_by")
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if ((value)['$<=>'](by) < 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    }, TMP_57.$$arity = 0);

    Opal.defn(self, '$minmax', TMP_59 = function $$minmax() {
      var $a, $b, $c, TMP_60, self = this, $iter = TMP_59.$$p, block = $iter || nil;

      TMP_59.$$p = null;
      ((($a = block) !== false && $a !== nil && $a != null) ? $a : block = ($b = ($c = self).$proc, $b.$$p = (TMP_60 = function(a, b){var self = TMP_60.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
      return a['$<=>'](b)}, TMP_60.$$s = self, TMP_60.$$arity = 2, TMP_60), $b).call($c));
      
      var min = nil, max = nil, first_time = true;

      self.$each.$$p = function() {
        var element = $scope.get('Opal').$destructure(arguments);
        if (first_time) {
          min = max = element;
          first_time = false;
        } else {
          var min_cmp = block.$call(min, element);

          if (min_cmp === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed")
          } else if (min_cmp > 0) {
            min = element;
          }

          var max_cmp = block.$call(max, element);

          if (max_cmp === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed")
          } else if (max_cmp < 0) {
            max = element;
          }
        }
      }

      self.$each();

      return [min, max];
    
    }, TMP_59.$$arity = 0);

    Opal.defn(self, '$minmax_by', TMP_61 = function $$minmax_by() {
      var self = this, $iter = TMP_61.$$p, block = $iter || nil;

      TMP_61.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    }, TMP_61.$$arity = 0);

    Opal.defn(self, '$none?', TMP_62 = function() {try {

      var $a, $b, TMP_63, $c, TMP_64, self = this, $iter = TMP_62.$$p, block = $iter || nil;

      TMP_62.$$p = null;
      if ((block !== nil)) {
        ($a = ($b = self).$each, $a.$$p = (TMP_63 = function($c_rest){var self = TMP_63.$$s || this, value, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($d = Opal.yieldX(block, Opal.to_a(value))) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            Opal.ret(false)
            } else {
            return nil
          }}, TMP_63.$$s = self, TMP_63.$$arity = -1, TMP_63), $a).call($b)
        } else {
        ($a = ($c = self).$each, $a.$$p = (TMP_64 = function($d_rest){var self = TMP_64.$$s || this, value, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($e = $scope.get('Opal').$destructure(value)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
            Opal.ret(false)
            } else {
            return nil
          }}, TMP_64.$$s = self, TMP_64.$$arity = -1, TMP_64), $a).call($c)
      };
      return true;
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_62.$$arity = 0);

    Opal.defn(self, '$one?', TMP_65 = function() {try {

      var $a, $b, TMP_66, $c, TMP_67, self = this, $iter = TMP_65.$$p, block = $iter || nil, count = nil;

      TMP_65.$$p = null;
      count = 0;
      if ((block !== nil)) {
        ($a = ($b = self).$each, $a.$$p = (TMP_66 = function($c_rest){var self = TMP_66.$$s || this, value, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($d = Opal.yieldX(block, Opal.to_a(value))) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            count = $rb_plus(count, 1);
            if ((($d = $rb_gt(count, 1)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
              Opal.ret(false)
              } else {
              return nil
            };
            } else {
            return nil
          }}, TMP_66.$$s = self, TMP_66.$$arity = -1, TMP_66), $a).call($b)
        } else {
        ($a = ($c = self).$each, $a.$$p = (TMP_67 = function($d_rest){var self = TMP_67.$$s || this, value, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 0;
          if ($rest_len < 0) { $rest_len = 0; }
          value = new Array($rest_len);
          for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
            value[$arg_idx - 0] = arguments[$arg_idx];
          }
        if ((($e = $scope.get('Opal').$destructure(value)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
            count = $rb_plus(count, 1);
            if ((($e = $rb_gt(count, 1)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
              Opal.ret(false)
              } else {
              return nil
            };
            } else {
            return nil
          }}, TMP_67.$$s = self, TMP_67.$$arity = -1, TMP_67), $a).call($c)
      };
      return count['$=='](1);
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_65.$$arity = 0);

    Opal.defn(self, '$partition', TMP_68 = function $$partition() {
      var $a, $b, TMP_69, self = this, $iter = TMP_68.$$p, block = $iter || nil;

      TMP_68.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_69 = function(){var self = TMP_69.$$s || this;

        return self.$enumerator_size()}, TMP_69.$$s = self, TMP_69.$$arity = 0, TMP_69), $a).call($b, "partition")
      };
      
      var truthy = [], falsy = [], result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if ((($a = value) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          truthy.push(param);
        }
        else {
          falsy.push(param);
        }
      };

      self.$each();

      return [truthy, falsy];
    
    }, TMP_68.$$arity = 0);

    Opal.alias(self, 'reduce', 'inject');

    Opal.defn(self, '$reject', TMP_70 = function $$reject() {
      var $a, $b, TMP_71, self = this, $iter = TMP_70.$$p, block = $iter || nil;

      TMP_70.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_71 = function(){var self = TMP_71.$$s || this;

        return self.$enumerator_size()}, TMP_71.$$s = self, TMP_71.$$arity = 0, TMP_71), $a).call($b, "reject")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if ((($a = value) === nil || $a == null || ($a.$$is_boolean && $a == false))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    }, TMP_70.$$arity = 0);

    Opal.defn(self, '$reverse_each', TMP_72 = function $$reverse_each() {
      var $a, $b, TMP_73, self = this, $iter = TMP_72.$$p, block = $iter || nil;

      TMP_72.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_73 = function(){var self = TMP_73.$$s || this;

        return self.$enumerator_size()}, TMP_73.$$s = self, TMP_73.$$arity = 0, TMP_73), $a).call($b, "reverse_each")
      };
      
      var result = [];

      self.$each.$$p = function() {
        result.push(arguments);
      };

      self.$each();

      for (var i = result.length - 1; i >= 0; i--) {
        Opal.yieldX(block, result[i]);
      }

      return result;
    
    }, TMP_72.$$arity = 0);

    Opal.alias(self, 'select', 'find_all');

    Opal.defn(self, '$slice_before', TMP_74 = function $$slice_before(pattern) {
      var $a, $b, TMP_75, self = this, $iter = TMP_74.$$p, block = $iter || nil;

      TMP_74.$$p = null;
      if ((($a = pattern === undefined && block === nil || arguments.length > 1) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 1)")};
      return ($a = ($b = $scope.get('Enumerator')).$new, $a.$$p = (TMP_75 = function(e){var self = TMP_75.$$s || this, $c;
if (e == null) e = nil;
      
        var slice = [];

        if (block !== nil) {
          if (pattern === undefined) {
            self.$each.$$p = function() {
              var param = $scope.get('Opal').$destructure(arguments),
                  value = Opal.yield1(block, param);

              if ((($c = value) !== nil && $c != null && (!$c.$$is_boolean || $c == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
          else {
            self.$each.$$p = function() {
              var param = $scope.get('Opal').$destructure(arguments),
                  value = block(param, pattern.$dup());

              if ((($c = value) !== nil && $c != null && (!$c.$$is_boolean || $c == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
        }
        else {
          self.$each.$$p = function() {
            var param = $scope.get('Opal').$destructure(arguments),
                value = pattern['$==='](param);

            if ((($c = value) !== nil && $c != null && (!$c.$$is_boolean || $c == true)) && slice.length > 0) {
              e['$<<'](slice);
              slice = [];
            }

            slice.push(param);
          };
        }

        self.$each();

        if (slice.length > 0) {
          e['$<<'](slice);
        }
      ;}, TMP_75.$$s = self, TMP_75.$$arity = 1, TMP_75), $a).call($b);
    }, TMP_74.$$arity = -1);

    Opal.defn(self, '$sort', TMP_76 = function $$sort() {
      var $a, $b, TMP_77, $c, self = this, $iter = TMP_76.$$p, block = $iter || nil, ary = nil;

      TMP_76.$$p = null;
      ary = self.$to_a();
      if ((block !== nil)) {
        } else {
        block = ($a = ($b = self).$lambda, $a.$$p = (TMP_77 = function(a, b){var self = TMP_77.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
        return a['$<=>'](b)}, TMP_77.$$s = self, TMP_77.$$arity = 2, TMP_77), $a).call($b)
      };
      return ($a = ($c = ary).$sort, $a.$$p = block.$to_proc(), $a).call($c);
    }, TMP_76.$$arity = 0);

    Opal.defn(self, '$sort_by', TMP_78 = function $$sort_by() {
      var $a, $b, TMP_79, $c, TMP_80, $d, TMP_81, $e, TMP_82, self = this, $iter = TMP_78.$$p, block = $iter || nil, dup = nil;

      TMP_78.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_79 = function(){var self = TMP_79.$$s || this;

        return self.$enumerator_size()}, TMP_79.$$s = self, TMP_79.$$arity = 0, TMP_79), $a).call($b, "sort_by")
      };
      dup = ($a = ($c = self).$map, $a.$$p = (TMP_80 = function(){var self = TMP_80.$$s || this, $yielded, arg = nil;

      arg = $scope.get('Opal').$destructure(arguments);
        ($yielded = Opal.yield1(block, arg));return [$yielded, arg];}, TMP_80.$$s = self, TMP_80.$$arity = 0, TMP_80), $a).call($c);
      ($a = ($d = dup)['$sort!'], $a.$$p = (TMP_81 = function(a, b){var self = TMP_81.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
      return (a[0])['$<=>'](b[0])}, TMP_81.$$s = self, TMP_81.$$arity = 2, TMP_81), $a).call($d);
      return ($a = ($e = dup)['$map!'], $a.$$p = (TMP_82 = function(i){var self = TMP_82.$$s || this;
if (i == null) i = nil;
      return i[1];}, TMP_82.$$s = self, TMP_82.$$arity = 1, TMP_82), $a).call($e);
    }, TMP_78.$$arity = 0);

    Opal.defn(self, '$take', TMP_83 = function $$take(num) {
      var self = this;

      return self.$first(num);
    }, TMP_83.$$arity = 1);

    Opal.defn(self, '$take_while', TMP_84 = function $$take_while() {try {

      var $a, $b, TMP_85, self = this, $iter = TMP_84.$$p, block = $iter || nil, result = nil;

      TMP_84.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return self.$enum_for("take_while")
      };
      result = [];
      return ($a = ($b = self).$each, $a.$$p = (TMP_85 = function($c_rest){var self = TMP_85.$$s || this, args, $d, value = nil;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
      value = $scope.get('Opal').$destructure(args);
        if ((($d = Opal.yield1(block, value)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
          } else {
          Opal.ret(result)
        };
        return result.push(value);}, TMP_85.$$s = self, TMP_85.$$arity = -1, TMP_85), $a).call($b);
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_84.$$arity = 0);

    Opal.alias(self, 'to_a', 'entries');

    Opal.defn(self, '$zip', TMP_86 = function $$zip($a_rest) {
      var $b, self = this, others, $iter = TMP_86.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      others = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        others[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_86.$$p = null;
      return ($b = self.$to_a()).$zip.apply($b, Opal.to_a(others));
    }, TMP_86.$$arity = -1);
  })($scope.base)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/enumerator"] = function(Opal) {
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$allocate', '$new', '$to_proc', '$coerce_to', '$nil?', '$empty?', '$+', '$class', '$__send__', '$===', '$call', '$enum_for', '$size', '$destructure', '$inspect', '$[]', '$raise', '$yield', '$each', '$enumerator_size', '$respond_to?', '$try_convert', '$<', '$for']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Enumerator(){};
    var self = $Enumerator = $klass($base, $super, 'Enumerator', $Enumerator);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_7;

    def.size = def.args = def.object = def.method = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_enumerator = true;

    Opal.defs(self, '$for', TMP_1 = function(object, method, $a_rest) {
      var self = this, args, $iter = TMP_1.$$p, block = $iter || nil;

      if (method == null) {
        method = "each";
      }
      var $args_len = arguments.length, $rest_len = $args_len - 2;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 2; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 2] = arguments[$arg_idx];
      }
      TMP_1.$$p = null;
      
      var obj = self.$allocate();

      obj.object = object;
      obj.size   = block;
      obj.method = method;
      obj.args   = args;

      return obj;
    ;
    }, TMP_1.$$arity = -2);

    Opal.defn(self, '$initialize', TMP_2 = function $$initialize($a_rest) {
      var $b, $c, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if (block !== false && block !== nil && block != null) {
        self.object = ($b = ($c = $scope.get('Generator')).$new, $b.$$p = block.$to_proc(), $b).call($c);
        self.method = "each";
        self.args = [];
        self.size = arguments[0] || nil;
        if ((($b = self.size) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          return self.size = $scope.get('Opal').$coerce_to(self.size, $scope.get('Integer'), "to_int")
          } else {
          return nil
        };
        } else {
        self.object = arguments[0];
        self.method = arguments[1] || "each";
        self.args = $slice.call(arguments, 2);
        return self.size = nil;
      };
    }, TMP_2.$$arity = -1);

    Opal.defn(self, '$each', TMP_3 = function $$each($a_rest) {
      var $b, $c, $d, self = this, args, $iter = TMP_3.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_3.$$p = null;
      if ((($b = ($c = block['$nil?'](), $c !== false && $c !== nil && $c != null ?args['$empty?']() : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        return self};
      args = $rb_plus(self.args, args);
      if ((($b = block['$nil?']()) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        return ($b = self.$class()).$new.apply($b, [self.object, self.method].concat(Opal.to_a(args)))};
      return ($c = ($d = self.object).$__send__, $c.$$p = block.$to_proc(), $c).apply($d, [self.method].concat(Opal.to_a(args)));
    }, TMP_3.$$arity = -1);

    Opal.defn(self, '$size', TMP_4 = function $$size() {
      var $a, self = this;

      if ((($a = $scope.get('Proc')['$==='](self.size)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($a = self.size).$call.apply($a, Opal.to_a(self.args))
        } else {
        return self.size
      };
    }, TMP_4.$$arity = 0);

    Opal.defn(self, '$with_index', TMP_5 = function $$with_index(offset) {
      var $a, $b, TMP_6, self = this, $iter = TMP_5.$$p, block = $iter || nil;

      if (offset == null) {
        offset = 0;
      }
      TMP_5.$$p = null;
      if (offset !== false && offset !== nil && offset != null) {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int")
        } else {
        offset = 0
      };
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_6 = function(){var self = TMP_6.$$s || this;

        return self.$size()}, TMP_6.$$s = self, TMP_6.$$arity = 0, TMP_6), $a).call($b, "with_index", offset)
      };
      
      var result, index = offset;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, index);

        index++;

        return value;
      }

      return self.$each();
    
    }, TMP_5.$$arity = -1);

    Opal.alias(self, 'with_object', 'each_with_object');

    Opal.defn(self, '$inspect', TMP_7 = function $$inspect() {
      var $a, self = this, result = nil;

      result = "#<" + (self.$class()) + ": " + (self.object.$inspect()) + ":" + (self.method);
      if ((($a = self.args['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        result = $rb_plus(result, "(" + (self.args.$inspect()['$[]']($scope.get('Range').$new(1, -2))) + ")")
      };
      return $rb_plus(result, ">");
    }, TMP_7.$$arity = 0);

    (function($base, $super) {
      function $Generator(){};
      var self = $Generator = $klass($base, $super, 'Generator', $Generator);

      var def = self.$$proto, $scope = self.$$scope, TMP_8, TMP_9;

      def.block = nil;
      self.$include($scope.get('Enumerable'));

      Opal.defn(self, '$initialize', TMP_8 = function $$initialize() {
        var self = this, $iter = TMP_8.$$p, block = $iter || nil;

        TMP_8.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('LocalJumpError'), "no block given")
        };
        return self.block = block;
      }, TMP_8.$$arity = 0);

      return (Opal.defn(self, '$each', TMP_9 = function $$each($a_rest) {
        var $b, $c, self = this, args, $iter = TMP_9.$$p, block = $iter || nil, yielder = nil;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
        TMP_9.$$p = null;
        yielder = ($b = ($c = $scope.get('Yielder')).$new, $b.$$p = block.$to_proc(), $b).call($c);
        
        try {
          args.unshift(yielder);

          Opal.yieldX(self.block, args);
        }
        catch (e) {
          if (e === $breaker) {
            return $breaker.$v;
          }
          else {
            throw e;
          }
        }
      ;
        return self;
      }, TMP_9.$$arity = -1), nil) && 'each';
    })($scope.base, null);

    (function($base, $super) {
      function $Yielder(){};
      var self = $Yielder = $klass($base, $super, 'Yielder', $Yielder);

      var def = self.$$proto, $scope = self.$$scope, TMP_10, TMP_11, TMP_12;

      def.block = nil;
      Opal.defn(self, '$initialize', TMP_10 = function $$initialize() {
        var self = this, $iter = TMP_10.$$p, block = $iter || nil;

        TMP_10.$$p = null;
        return self.block = block;
      }, TMP_10.$$arity = 0);

      Opal.defn(self, '$yield', TMP_11 = function($a_rest) {
        var self = this, values;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        values = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          values[$arg_idx - 0] = arguments[$arg_idx];
        }
        
        var value = Opal.yieldX(self.block, values);

        if (value === $breaker) {
          throw $breaker;
        }

        return value;
      ;
      }, TMP_11.$$arity = -1);

      return (Opal.defn(self, '$<<', TMP_12 = function($a_rest) {
        var $b, self = this, values;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        values = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          values[$arg_idx - 0] = arguments[$arg_idx];
        }
        ($b = self).$yield.apply($b, Opal.to_a(values));
        return self;
      }, TMP_12.$$arity = -1), nil) && '<<';
    })($scope.base, null);

    return (function($base, $super) {
      function $Lazy(){};
      var self = $Lazy = $klass($base, $super, 'Lazy', $Lazy);

      var def = self.$$proto, $scope = self.$$scope, TMP_13, TMP_16, TMP_17, TMP_19, TMP_24, TMP_25, TMP_27, TMP_28, TMP_30, TMP_33, TMP_36, TMP_37, TMP_39;

      def.enumerator = nil;
      (function($base, $super) {
        function $StopLazyError(){};
        var self = $StopLazyError = $klass($base, $super, 'StopLazyError', $StopLazyError);

        var def = self.$$proto, $scope = self.$$scope;

        return nil;
      })($scope.base, $scope.get('Exception'));

      Opal.defn(self, '$initialize', TMP_13 = function $$initialize(object, size) {
        var $a, $b, TMP_14, self = this, $iter = TMP_13.$$p, block = $iter || nil;

        if (size == null) {
          size = nil;
        }
        TMP_13.$$p = null;
        if ((block !== nil)) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy new without a block")
        };
        self.enumerator = object;
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'initialize', TMP_13, false)), $a.$$p = (TMP_14 = function(yielder, $c_rest){var self = TMP_14.$$s || this, each_args, $d, $e, TMP_15;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          each_args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            each_args[$arg_idx - 1] = arguments[$arg_idx];
          }if (yielder == null) yielder = nil;
        try {
            return ($d = ($e = object).$each, $d.$$p = (TMP_15 = function($c_rest){var self = TMP_15.$$s || this, args;

              var $args_len = arguments.length, $rest_len = $args_len - 0;
              if ($rest_len < 0) { $rest_len = 0; }
              args = new Array($rest_len);
              for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
                args[$arg_idx - 0] = arguments[$arg_idx];
              }
            
              args.unshift(yielder);

              Opal.yieldX(block, args);
            ;}, TMP_15.$$s = self, TMP_15.$$arity = -1, TMP_15), $d).apply($e, Opal.to_a(each_args))
          } catch ($err) {
            if (Opal.rescue($err, [$scope.get('Exception')])) {
              try {
                return nil
              } finally { Opal.pop_exception() }
            } else { throw $err; }
          }}, TMP_14.$$s = self, TMP_14.$$arity = -2, TMP_14), $a).call($b, size);
      }, TMP_13.$$arity = -2);

      Opal.alias(self, 'force', 'to_a');

      Opal.defn(self, '$lazy', TMP_16 = function $$lazy() {
        var self = this;

        return self;
      }, TMP_16.$$arity = 0);

      Opal.defn(self, '$collect', TMP_17 = function $$collect() {
        var $a, $b, TMP_18, self = this, $iter = TMP_17.$$p, block = $iter || nil;

        TMP_17.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy map without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_18 = function(enum$, $c_rest){var self = TMP_18.$$s || this, args;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        
          var value = Opal.yieldX(block, args);

          enum$.$yield(value);
        }, TMP_18.$$s = self, TMP_18.$$arity = -2, TMP_18), $a).call($b, self, self.$enumerator_size());
      }, TMP_17.$$arity = 0);

      Opal.defn(self, '$collect_concat', TMP_19 = function $$collect_concat() {
        var $a, $b, TMP_20, self = this, $iter = TMP_19.$$p, block = $iter || nil;

        TMP_19.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy map without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_20 = function(enum$, $c_rest){var self = TMP_20.$$s || this, args, $d, $e, TMP_21, $f, TMP_22;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        
          var value = Opal.yieldX(block, args);

          if ((value)['$respond_to?']("force") && (value)['$respond_to?']("each")) {
            ($d = ($e = (value)).$each, $d.$$p = (TMP_21 = function(v){var self = TMP_21.$$s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_21.$$s = self, TMP_21.$$arity = 1, TMP_21), $d).call($e)
          }
          else {
            var array = $scope.get('Opal').$try_convert(value, $scope.get('Array'), "to_ary");

            if (array === nil) {
              enum$.$yield(value);
            }
            else {
              ($d = ($f = (value)).$each, $d.$$p = (TMP_22 = function(v){var self = TMP_22.$$s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_22.$$s = self, TMP_22.$$arity = 1, TMP_22), $d).call($f);
            }
          }
        ;}, TMP_20.$$s = self, TMP_20.$$arity = -2, TMP_20), $a).call($b, self, nil);
      }, TMP_19.$$arity = 0);

      Opal.defn(self, '$drop', TMP_24 = function $$drop(n) {
        var $a, $b, TMP_23, self = this, current_size = nil, set_size = nil, dropped = nil;

        n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
        if ((($a = $rb_lt(n, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "attempt to drop negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = $scope.get('Integer')['$==='](current_size)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = $rb_lt(n, current_size)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        dropped = 0;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_23 = function(enum$, $c_rest){var self = TMP_23.$$s || this, args, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        if ((($d = $rb_lt(dropped, n)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            return dropped = $rb_plus(dropped, 1)
            } else {
            return ($d = enum$).$yield.apply($d, Opal.to_a(args))
          }}, TMP_23.$$s = self, TMP_23.$$arity = -2, TMP_23), $a).call($b, self, set_size);
      }, TMP_24.$$arity = 1);

      Opal.defn(self, '$drop_while', TMP_25 = function $$drop_while() {
        var $a, $b, TMP_26, self = this, $iter = TMP_25.$$p, block = $iter || nil, succeeding = nil;

        TMP_25.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy drop_while without a block")
        };
        succeeding = true;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_26 = function(enum$, $c_rest){var self = TMP_26.$$s || this, args, $d, $e;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        if (succeeding !== false && succeeding !== nil && succeeding != null) {
            
            var value = Opal.yieldX(block, args);

            if ((($d = value) === nil || $d == null || ($d.$$is_boolean && $d == false))) {
              succeeding = false;

              ($d = enum$).$yield.apply($d, Opal.to_a(args));
            }
          
            } else {
            return ($e = enum$).$yield.apply($e, Opal.to_a(args))
          }}, TMP_26.$$s = self, TMP_26.$$arity = -2, TMP_26), $a).call($b, self, nil);
      }, TMP_25.$$arity = 0);

      Opal.defn(self, '$enum_for', TMP_27 = function $$enum_for(method, $a_rest) {
        var $b, $c, self = this, args, $iter = TMP_27.$$p, block = $iter || nil;

        if (method == null) {
          method = "each";
        }
        var $args_len = arguments.length, $rest_len = $args_len - 1;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 1] = arguments[$arg_idx];
        }
        TMP_27.$$p = null;
        return ($b = ($c = self.$class()).$for, $b.$$p = block.$to_proc(), $b).apply($c, [self, method].concat(Opal.to_a(args)));
      }, TMP_27.$$arity = -1);

      Opal.defn(self, '$find_all', TMP_28 = function $$find_all() {
        var $a, $b, TMP_29, self = this, $iter = TMP_28.$$p, block = $iter || nil;

        TMP_28.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy select without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_29 = function(enum$, $c_rest){var self = TMP_29.$$s || this, args, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        
          var value = Opal.yieldX(block, args);

          if ((($d = value) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            ($d = enum$).$yield.apply($d, Opal.to_a(args));
          }
        ;}, TMP_29.$$s = self, TMP_29.$$arity = -2, TMP_29), $a).call($b, self, nil);
      }, TMP_28.$$arity = 0);

      Opal.alias(self, 'flat_map', 'collect_concat');

      Opal.defn(self, '$grep', TMP_30 = function $$grep(pattern) {
        var $a, $b, TMP_31, $c, TMP_32, self = this, $iter = TMP_30.$$p, block = $iter || nil;

        TMP_30.$$p = null;
        if (block !== false && block !== nil && block != null) {
          return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_31 = function(enum$, $c_rest){var self = TMP_31.$$s || this, args, $d;

            var $args_len = arguments.length, $rest_len = $args_len - 1;
            if ($rest_len < 0) { $rest_len = 0; }
            args = new Array($rest_len);
            for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
              args[$arg_idx - 1] = arguments[$arg_idx];
            }if (enum$ == null) enum$ = nil;
          
            var param = $scope.get('Opal').$destructure(args),
                value = pattern['$==='](param);

            if ((($d = value) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
              value = Opal.yield1(block, param);

              enum$.$yield(Opal.yield1(block, param));
            }
          ;}, TMP_31.$$s = self, TMP_31.$$arity = -2, TMP_31), $a).call($b, self, nil)
          } else {
          return ($a = ($c = $scope.get('Lazy')).$new, $a.$$p = (TMP_32 = function(enum$, $d_rest){var self = TMP_32.$$s || this, args, $e;

            var $args_len = arguments.length, $rest_len = $args_len - 1;
            if ($rest_len < 0) { $rest_len = 0; }
            args = new Array($rest_len);
            for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
              args[$arg_idx - 1] = arguments[$arg_idx];
            }if (enum$ == null) enum$ = nil;
          
            var param = $scope.get('Opal').$destructure(args),
                value = pattern['$==='](param);

            if ((($e = value) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
              enum$.$yield(param);
            }
          ;}, TMP_32.$$s = self, TMP_32.$$arity = -2, TMP_32), $a).call($c, self, nil)
        };
      }, TMP_30.$$arity = 1);

      Opal.alias(self, 'map', 'collect');

      Opal.alias(self, 'select', 'find_all');

      Opal.defn(self, '$reject', TMP_33 = function $$reject() {
        var $a, $b, TMP_34, self = this, $iter = TMP_33.$$p, block = $iter || nil;

        TMP_33.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy reject without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_34 = function(enum$, $c_rest){var self = TMP_34.$$s || this, args, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        
          var value = Opal.yieldX(block, args);

          if ((($d = value) === nil || $d == null || ($d.$$is_boolean && $d == false))) {
            ($d = enum$).$yield.apply($d, Opal.to_a(args));
          }
        ;}, TMP_34.$$s = self, TMP_34.$$arity = -2, TMP_34), $a).call($b, self, nil);
      }, TMP_33.$$arity = 0);

      Opal.defn(self, '$take', TMP_36 = function $$take(n) {
        var $a, $b, TMP_35, self = this, current_size = nil, set_size = nil, taken = nil;

        n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
        if ((($a = $rb_lt(n, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "attempt to take negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = $scope.get('Integer')['$==='](current_size)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = $rb_lt(n, current_size)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        taken = 0;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_35 = function(enum$, $c_rest){var self = TMP_35.$$s || this, args, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        if ((($d = $rb_lt(taken, n)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            ($d = enum$).$yield.apply($d, Opal.to_a(args));
            return taken = $rb_plus(taken, 1);
            } else {
            return self.$raise($scope.get('StopLazyError'))
          }}, TMP_35.$$s = self, TMP_35.$$arity = -2, TMP_35), $a).call($b, self, set_size);
      }, TMP_36.$$arity = 1);

      Opal.defn(self, '$take_while', TMP_37 = function $$take_while() {
        var $a, $b, TMP_38, self = this, $iter = TMP_37.$$p, block = $iter || nil;

        TMP_37.$$p = null;
        if (block !== false && block !== nil && block != null) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy take_while without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_38 = function(enum$, $c_rest){var self = TMP_38.$$s || this, args, $d;

          var $args_len = arguments.length, $rest_len = $args_len - 1;
          if ($rest_len < 0) { $rest_len = 0; }
          args = new Array($rest_len);
          for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
            args[$arg_idx - 1] = arguments[$arg_idx];
          }if (enum$ == null) enum$ = nil;
        
          var value = Opal.yieldX(block, args);

          if ((($d = value) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            ($d = enum$).$yield.apply($d, Opal.to_a(args));
          }
          else {
            self.$raise($scope.get('StopLazyError'));
          }
        ;}, TMP_38.$$s = self, TMP_38.$$arity = -2, TMP_38), $a).call($b, self, nil);
      }, TMP_37.$$arity = 0);

      Opal.alias(self, 'to_enum', 'enum_for');

      return (Opal.defn(self, '$inspect', TMP_39 = function $$inspect() {
        var self = this;

        return "#<" + (self.$class()) + ": " + (self.enumerator.$inspect()) + ">";
      }, TMP_39.$$arity = 0), nil) && 'inspect';
    })($scope.base, self);
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/numeric"] = function(Opal) {
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$instance_of?', '$class', '$Float', '$coerce', '$===', '$raise', '$__send__', '$equal?', '$coerce_to!', '$-@', '$**', '$-', '$*', '$div', '$<', '$ceil', '$to_f', '$denominator', '$to_r', '$==', '$floor', '$/', '$%', '$Complex', '$zero?', '$numerator', '$abs', '$arg', '$round', '$to_i', '$truncate', '$>']);
  self.$require("corelib/comparable");
  return (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_35, TMP_36;

    self.$include($scope.get('Comparable'));

    Opal.defn(self, '$coerce', TMP_1 = function $$coerce(other) {
      var $a, self = this;

      if ((($a = other['$instance_of?'](self.$class())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return [other, self]};
      return [self.$Float(other), self.$Float(self)];
    }, TMP_1.$$arity = 1);

    Opal.defn(self, '$__coerced__', TMP_2 = function $$__coerced__(method, other) {
      var $a, $b, self = this, a = nil, b = nil, $case = nil;

      try {
        $b = other.$coerce(self), $a = Opal.to_ary($b), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]), $b
      } catch ($err) {
        if (Opal.rescue($err, [$scope.get('StandardError')])) {
          try {
            $case = method;if ("+"['$===']($case) || "-"['$===']($case) || "*"['$===']($case) || "/"['$===']($case) || "%"['$===']($case) || "&"['$===']($case) || "|"['$===']($case) || "^"['$===']($case) || "**"['$===']($case)) {self.$raise($scope.get('TypeError'), "" + (other.$class()) + " can't be coerce into Numeric")}else if (">"['$===']($case) || ">="['$===']($case) || "<"['$===']($case) || "<="['$===']($case) || "<=>"['$===']($case)) {self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")}
          } finally { Opal.pop_exception() }
        } else { throw $err; }
      };
      return a.$__send__(method, b);
    }, TMP_2.$$arity = 2);

    Opal.defn(self, '$<=>', TMP_3 = function(other) {
      var $a, self = this;

      if ((($a = self['$equal?'](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return 0};
      return nil;
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$[]', TMP_4 = function(bit) {
      var self = this, min = nil, max = nil;

      bit = $scope.get('Opal')['$coerce_to!'](bit, $scope.get('Integer'), "to_int");
      min = ((2)['$**'](30))['$-@']();
      max = $rb_minus(((2)['$**'](30)), 1);
      return (bit < min || bit > max) ? 0 : (self >> bit) % 2;
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$+@', TMP_5 = function() {
      var self = this;

      return self;
    }, TMP_5.$$arity = 0);

    Opal.defn(self, '$-@', TMP_6 = function() {
      var self = this;

      return $rb_minus(0, self);
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$%', TMP_7 = function(other) {
      var self = this;

      return $rb_minus(self, $rb_times(other, self.$div(other)));
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$abs', TMP_8 = function $$abs() {
      var self = this;

      if ($rb_lt(self, 0)) {
        return self['$-@']()
        } else {
        return self
      };
    }, TMP_8.$$arity = 0);

    Opal.defn(self, '$abs2', TMP_9 = function $$abs2() {
      var self = this;

      return $rb_times(self, self);
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$angle', TMP_10 = function $$angle() {
      var self = this;

      if ($rb_lt(self, 0)) {
        return (($scope.get('Math')).$$scope.get('PI'))
        } else {
        return 0
      };
    }, TMP_10.$$arity = 0);

    Opal.alias(self, 'arg', 'angle');

    Opal.defn(self, '$ceil', TMP_11 = function $$ceil() {
      var self = this;

      return self.$to_f().$ceil();
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$conj', TMP_12 = function $$conj() {
      var self = this;

      return self;
    }, TMP_12.$$arity = 0);

    Opal.alias(self, 'conjugate', 'conj');

    Opal.defn(self, '$denominator', TMP_13 = function $$denominator() {
      var self = this;

      return self.$to_r().$denominator();
    }, TMP_13.$$arity = 0);

    Opal.defn(self, '$div', TMP_14 = function $$div(other) {
      var self = this;

      if (other['$=='](0)) {
        self.$raise($scope.get('ZeroDivisionError'), "divided by o")};
      return ($rb_divide(self, other)).$floor();
    }, TMP_14.$$arity = 1);

    Opal.defn(self, '$divmod', TMP_15 = function $$divmod(other) {
      var self = this;

      return [self.$div(other), self['$%'](other)];
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$fdiv', TMP_16 = function $$fdiv(other) {
      var self = this;

      return $rb_divide(self.$to_f(), other);
    }, TMP_16.$$arity = 1);

    Opal.defn(self, '$floor', TMP_17 = function $$floor() {
      var self = this;

      return self.$to_f().$floor();
    }, TMP_17.$$arity = 0);

    Opal.defn(self, '$i', TMP_18 = function $$i() {
      var self = this;

      return self.$Complex(0, self);
    }, TMP_18.$$arity = 0);

    Opal.defn(self, '$imag', TMP_19 = function $$imag() {
      var self = this;

      return 0;
    }, TMP_19.$$arity = 0);

    Opal.alias(self, 'imaginary', 'imag');

    Opal.defn(self, '$integer?', TMP_20 = function() {
      var self = this;

      return false;
    }, TMP_20.$$arity = 0);

    Opal.alias(self, 'magnitude', 'abs');

    Opal.alias(self, 'modulo', '%');

    Opal.defn(self, '$nonzero?', TMP_21 = function() {
      var $a, self = this;

      if ((($a = self['$zero?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return nil
        } else {
        return self
      };
    }, TMP_21.$$arity = 0);

    Opal.defn(self, '$numerator', TMP_22 = function $$numerator() {
      var self = this;

      return self.$to_r().$numerator();
    }, TMP_22.$$arity = 0);

    Opal.alias(self, 'phase', 'arg');

    Opal.defn(self, '$polar', TMP_23 = function $$polar() {
      var self = this;

      return [self.$abs(), self.$arg()];
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$quo', TMP_24 = function $$quo(other) {
      var self = this;

      return $rb_divide($scope.get('Opal')['$coerce_to!'](self, $scope.get('Rational'), "to_r"), other);
    }, TMP_24.$$arity = 1);

    Opal.defn(self, '$real', TMP_25 = function $$real() {
      var self = this;

      return self;
    }, TMP_25.$$arity = 0);

    Opal.defn(self, '$real?', TMP_26 = function() {
      var self = this;

      return true;
    }, TMP_26.$$arity = 0);

    Opal.defn(self, '$rect', TMP_27 = function $$rect() {
      var self = this;

      return [self, 0];
    }, TMP_27.$$arity = 0);

    Opal.alias(self, 'rectangular', 'rect');

    Opal.defn(self, '$round', TMP_28 = function $$round(digits) {
      var self = this;

      return self.$to_f().$round(digits);
    }, TMP_28.$$arity = -1);

    Opal.defn(self, '$to_c', TMP_29 = function $$to_c() {
      var self = this;

      return self.$Complex(self, 0);
    }, TMP_29.$$arity = 0);

    Opal.defn(self, '$to_int', TMP_30 = function $$to_int() {
      var self = this;

      return self.$to_i();
    }, TMP_30.$$arity = 0);

    Opal.defn(self, '$truncate', TMP_31 = function $$truncate() {
      var self = this;

      return self.$to_f().$truncate();
    }, TMP_31.$$arity = 0);

    Opal.defn(self, '$zero?', TMP_32 = function() {
      var self = this;

      return self['$=='](0);
    }, TMP_32.$$arity = 0);

    Opal.defn(self, '$positive?', TMP_33 = function() {
      var self = this;

      return $rb_gt(self, 0);
    }, TMP_33.$$arity = 0);

    Opal.defn(self, '$negative?', TMP_34 = function() {
      var self = this;

      return $rb_lt(self, 0);
    }, TMP_34.$$arity = 0);

    Opal.defn(self, '$dup', TMP_35 = function $$dup() {
      var self = this;

      return self.$raise($scope.get('TypeError'), "can't dup " + (self.$class()));
    }, TMP_35.$$arity = 0);

    return (Opal.defn(self, '$clone', TMP_36 = function $$clone() {
      var self = this;

      return self.$raise($scope.get('TypeError'), "can't clone " + (self.$class()));
    }, TMP_36.$$arity = 0), nil) && 'clone';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/array"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_ge(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs >= rhs : lhs['$>='](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $hash2 = Opal.hash2, $gvars = Opal.gvars;

  Opal.add_stubs(['$require', '$include', '$to_a', '$raise', '$===', '$replace', '$respond_to?', '$to_ary', '$coerce_to', '$coerce_to?', '$join', '$to_str', '$class', '$clone', '$hash', '$<=>', '$==', '$object_id', '$inspect', '$enum_for', '$coerce_to!', '$>', '$*', '$enumerator_size', '$empty?', '$size', '$eql?', '$length', '$begin', '$end', '$exclude_end?', '$flatten', '$__id__', '$[]', '$to_s', '$new', '$!', '$>=', '$**', '$delete_if', '$to_proc', '$each', '$reverse', '$rotate', '$rand', '$at', '$keep_if', '$shuffle!', '$dup', '$<', '$sort', '$sort_by', '$!=', '$times', '$[]=', '$<<', '$values', '$kind_of?', '$last', '$first', '$upto', '$reject', '$pristine']);
  self.$require("corelib/enumerable");
  self.$require("corelib/numeric");
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_19, TMP_20, TMP_21, TMP_22, TMP_24, TMP_26, TMP_28, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_35, TMP_37, TMP_38, TMP_39, TMP_41, TMP_43, TMP_44, TMP_45, TMP_46, TMP_47, TMP_48, TMP_49, TMP_50, TMP_51, TMP_52, TMP_53, TMP_54, TMP_55, TMP_56, TMP_58, TMP_59, TMP_60, TMP_62, TMP_64, TMP_65, TMP_66, TMP_67, TMP_68, TMP_70, TMP_72, TMP_73, TMP_74, TMP_75, TMP_77, TMP_78, TMP_79, TMP_82, TMP_83, TMP_85, TMP_87, TMP_88, TMP_89, TMP_90, TMP_91, TMP_92, TMP_93, TMP_95, TMP_96, TMP_97, TMP_98, TMP_101, TMP_102, TMP_103, TMP_104, TMP_107, TMP_108, TMP_109, TMP_111;

    def.length = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_array = true;

    
    function toArraySubclass(obj, klass) {
      if (klass.$$name === Opal.Array) {
        return obj;
      } else {
        return klass.$allocate().$replace((obj).$to_a());
      }
    }
  

    Opal.defs(self, '$[]', TMP_1 = function($a_rest) {
      var self = this, objects;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      objects = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        objects[$arg_idx - 0] = arguments[$arg_idx];
      }
      return toArraySubclass(objects, self);
    }, TMP_1.$$arity = -1);

    Opal.defn(self, '$initialize', TMP_2 = function $$initialize(size, obj) {
      var $a, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      if (size == null) {
        size = nil;
      }
      if (obj == null) {
        obj = nil;
      }
      TMP_2.$$p = null;
      if ((($a = arguments.length > 2) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..2)")};
      
      if (arguments.length === 0) {
        self.splice(0, self.length);
        return self;
      }
    
      if ((($a = arguments.length === 1) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Array')['$==='](size)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$replace(size.$to_a());
          return self;
        } else if ((($a = size['$respond_to?']("to_ary")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$replace(size.$to_ary());
          return self;}};
      size = $scope.get('Opal').$coerce_to(size, $scope.get('Integer'), "to_int");
      if ((($a = size < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      
      self.splice(0, self.length);
      var i, value;

      if (block === nil) {
        for (i = 0; i < size; i++) {
          self.push(obj);
        }
      }
      else {
        for (i = 0, value; i < size; i++) {
          value = block(i);
          self[i] = value;
        }
      }

      return self;
    
    }, TMP_2.$$arity = -1);

    Opal.defs(self, '$try_convert', TMP_3 = function $$try_convert(obj) {
      var self = this;

      return $scope.get('Opal')['$coerce_to?'](obj, $scope.get('Array'), "to_ary");
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$&', TMP_4 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      var result = [], hash = $hash2([], {}), i, length, item;

      for (i = 0, length = other.length; i < length; i++) {
        Opal.hash_put(hash, other[i], true);
      }

      for (i = 0, length = self.length; i < length; i++) {
        item = self[i];
        if (Opal.hash_delete(hash, item) !== undefined) {
          result.push(item);
        }
      }

      return result;
    ;
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$|', TMP_5 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      var hash = $hash2([], {}), i, length, item;

      for (i = 0, length = self.length; i < length; i++) {
        Opal.hash_put(hash, self[i], true);
      }

      for (i = 0, length = other.length; i < length; i++) {
        Opal.hash_put(hash, other[i], true);
      }

      return hash.$keys();
    ;
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$*', TMP_6 = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$join(other.$to_str())};
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      if ((($a = other < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative argument")};
      
      var result = [],
          converted = self.$to_a();

      for (var i = 0; i < other; i++) {
        result = result.concat(converted);
      }

      return toArraySubclass(result, self.$class());
    ;
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$+', TMP_7 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      return self.concat(other);
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$-', TMP_8 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      if ((($a = self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = other.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$clone().$to_a()};
      
      var result = [], hash = $hash2([], {}), i, length, item;

      for (i = 0, length = other.length; i < length; i++) {
        Opal.hash_put(hash, other[i], true);
      }

      for (i = 0, length = self.length; i < length; i++) {
        item = self[i];
        if (Opal.hash_get(hash, item) === undefined) {
          result.push(item);
        }
      }

      return result;
    ;
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$<<', TMP_9 = function(object) {
      var self = this;

      self.push(object);
      return self;
    }, TMP_9.$$arity = 1);

    Opal.defn(self, '$<=>', TMP_10 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
      } else if ((($a = other['$respond_to?']("to_ary")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_ary().$to_a()
        } else {
        return nil
      };
      
      if (self.$hash() === other.$hash()) {
        return 0;
      }

      var count = Math.min(self.length, other.length);

      for (var i = 0; i < count; i++) {
        var tmp = (self[i])['$<=>'](other[i]);

        if (tmp !== 0) {
          return tmp;
        }
      }

      return (self.length)['$<=>'](other.length);
    ;
    }, TMP_10.$$arity = 1);

    Opal.defn(self, '$==', TMP_11 = function(other) {
      var self = this;

      
      var recursed = {};

      function _eqeq(array, other) {
        var i, length, a, b;

        if (array === other)
          return true;

        if (!other.$$is_array) {
          if ($scope.get('Opal')['$respond_to?'](other, "to_ary")) {
            return (other)['$=='](array);
          } else {
            return false;
          }
        }

        if (array.constructor !== Array)
          array = (array).$to_a();
        if (other.constructor !== Array)
          other = (other).$to_a();

        if (array.length !== other.length) {
          return false;
        }

        recursed[(array).$object_id()] = true;

        for (i = 0, length = array.length; i < length; i++) {
          a = array[i];
          b = other[i];
          if (a.$$is_array) {
            if (b.$$is_array && b.length !== a.length) {
              return false;
            }
            if (!recursed.hasOwnProperty((a).$object_id())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$=='](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    ;
    }, TMP_11.$$arity = 1);

    Opal.defn(self, '$[]', TMP_12 = function(index, length) {
      var self = this;

      
      var size = self.length,
          exclude, from, to, result;

      if (index.$$is_range) {
        exclude = index.exclude;
        from    = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int");
        to      = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            return nil;
          }
        }

        if (from > size) {
          return nil;
        }

        if (to < 0) {
          to += size;

          if (to < 0) {
            return [];
          }
        }

        if (!exclude) {
          to += 1;
        }

        result = self.slice(from, to)
      }
      else {
        index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

        if (index < 0) {
          index += size;

          if (index < 0) {
            return nil;
          }
        }

        if (length === undefined) {
          if (index >= size || index < 0) {
            return nil;
          }

          return self[index];
        }
        else {
          length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

          if (length < 0 || index > size || index < 0) {
            return nil;
          }

          result = self.slice(index, index + length);
        }
      }

      return toArraySubclass(result, self.$class())
    ;
    }, TMP_12.$$arity = -2);

    Opal.defn(self, '$[]=', TMP_13 = function(index, value, extra) {
      var $a, self = this, data = nil, length = nil;

      
      var i, size = self.length;
    
      if ((($a = $scope.get('Range')['$==='](index)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Array')['$==='](value)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          data = value.$to_a()
        } else if ((($a = value['$respond_to?']("to_ary")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          data = value.$to_ary().$to_a()
          } else {
          data = [value]
        };
        
        var exclude = index.exclude,
            from    = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int"),
            to      = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            self.$raise($scope.get('RangeError'), "" + (index.$inspect()) + " out of range");
          }
        }

        if (to < 0) {
          to += size;
        }

        if (!exclude) {
          to += 1;
        }

        if (from > size) {
          for (i = size; i < from; i++) {
            self[i] = nil;
          }
        }

        if (to < 0) {
          self.splice.apply(self, [from, 0].concat(data));
        }
        else {
          self.splice.apply(self, [from, to - from].concat(data));
        }

        return value;
      ;
        } else {
        if ((($a = extra === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          length = 1
          } else {
          length = value;
          value = extra;
          if ((($a = $scope.get('Array')['$==='](value)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            data = value.$to_a()
          } else if ((($a = value['$respond_to?']("to_ary")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            data = value.$to_ary().$to_a()
            } else {
            data = [value]
          };
        };
        
        var old;

        index  = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
        length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

        if (index < 0) {
          old    = index;
          index += size;

          if (index < 0) {
            self.$raise($scope.get('IndexError'), "index " + (old) + " too small for array; minimum " + (-self.length));
          }
        }

        if (length < 0) {
          self.$raise($scope.get('IndexError'), "negative length (" + (length) + ")")
        }

        if (index > size) {
          for (i = size; i < index; i++) {
            self[i] = nil;
          }
        }

        if (extra === undefined) {
          self[index] = value;
        }
        else {
          self.splice.apply(self, [index, length].concat(data));
        }

        return value;
      
      };
    }, TMP_13.$$arity = -3);

    Opal.defn(self, '$assoc', TMP_14 = function $$assoc(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        if (item = self[i], item.length && (item[0])['$=='](object)) {
          return item;
        }
      }

      return nil;
    
    }, TMP_14.$$arity = 1);

    Opal.defn(self, '$at', TMP_15 = function $$at(index) {
      var self = this;

      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
      
      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self[index];
    
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$bsearch', TMP_16 = function $$bsearch() {
      var self = this, $iter = TMP_16.$$p, block = $iter || nil;

      TMP_16.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("bsearch")
      };
      
      var min = 0,
          max = self.length,
          mid,
          val,
          ret,
          smaller = false,
          satisfied = nil;

      while (min < max) {
        mid = min + Math.floor((max - min) / 2);
        val = self[mid];
        ret = block(val);

        if (ret === true) {
          satisfied = val;
          smaller = true;
        }
        else if (ret === false || ret === nil) {
          smaller = false;
        }
        else if (ret.$$is_number) {
          if (ret === 0) { return val; }
          smaller = (ret < 0);
        }
        else {
          self.$raise($scope.get('TypeError'), "wrong argument type " + ((ret).$class()) + " (must be numeric, true, false or nil)")
        }

        if (smaller) { max = mid; } else { min = mid + 1; }
      }

      return satisfied;
    
    }, TMP_16.$$arity = 0);

    Opal.defn(self, '$cycle', TMP_17 = function $$cycle(n) {
      var $a, $b, TMP_18, $c, self = this, $iter = TMP_17.$$p, block = $iter || nil;

      if (n == null) {
        n = nil;
      }
      TMP_17.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_18 = function(){var self = TMP_18.$$s || this, $c;

        if (n['$=='](nil)) {
            return (($scope.get('Float')).$$scope.get('INFINITY'))
            } else {
            n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
            if ((($c = $rb_gt(n, 0)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
              return $rb_times(self.$enumerator_size(), n)
              } else {
              return 0
            };
          }}, TMP_18.$$s = self, TMP_18.$$arity = 0, TMP_18), $a).call($b, "cycle", n)
      };
      if ((($a = ((($c = self['$empty?']()) !== false && $c !== nil && $c != null) ? $c : n['$=='](0))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return nil};
      
      var i, length, value;

      if (n === nil) {
        while (true) {
          for (i = 0, length = self.length; i < length; i++) {
            value = Opal.yield1(block, self[i]);
          }
        }
      }
      else {
        n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
        if (n <= 0) {
          return self;
        }

        while (n > 0) {
          for (i = 0, length = self.length; i < length; i++) {
            value = Opal.yield1(block, self[i]);
          }

          n--;
        }
      }
    
      return self;
    }, TMP_17.$$arity = -1);

    Opal.defn(self, '$clear', TMP_19 = function $$clear() {
      var self = this;

      self.splice(0, self.length);
      return self;
    }, TMP_19.$$arity = 0);

    Opal.defn(self, '$count', TMP_20 = function $$count(object) {
      var $a, $b, self = this, $iter = TMP_20.$$p, block = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      if (object == null) {
        object = nil;
      }
      TMP_20.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = ((($b = object) !== false && $b !== nil && $b != null) ? $b : block)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'count', TMP_20, false)), $a.$$p = $iter, $a).apply($b, $zuper)
        } else {
        return self.$size()
      };
    }, TMP_20.$$arity = -1);

    Opal.defn(self, '$initialize_copy', TMP_21 = function $$initialize_copy(other) {
      var self = this;

      return self.$replace(other);
    }, TMP_21.$$arity = 1);

    Opal.defn(self, '$collect', TMP_22 = function $$collect() {
      var $a, $b, TMP_23, self = this, $iter = TMP_22.$$p, block = $iter || nil;

      TMP_22.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_23 = function(){var self = TMP_23.$$s || this;

        return self.$size()}, TMP_23.$$s = self, TMP_23.$$arity = 0, TMP_23), $a).call($b, "collect")
      };
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);
        result.push(value);
      }

      return result;
    
    }, TMP_22.$$arity = 0);

    Opal.defn(self, '$collect!', TMP_24 = function() {
      var $a, $b, TMP_25, self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_25 = function(){var self = TMP_25.$$s || this;

        return self.$size()}, TMP_25.$$s = self, TMP_25.$$arity = 0, TMP_25), $a).call($b, "collect!")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);
        self[i] = value;
      }
    
      return self;
    }, TMP_24.$$arity = 0);

    
    function binomial_coefficient(n, k) {
      if (n === k || k === 0) {
        return 1;
      }

      if (k > 0 && n > k) {
        return binomial_coefficient(n - 1, k - 1) + binomial_coefficient(n - 1, k);
      }

      return 0;
    }
  

    Opal.defn(self, '$combination', TMP_26 = function $$combination(n) {
      var $a, $b, TMP_27, self = this, $iter = TMP_26.$$p, $yield = $iter || nil, num = nil;

      TMP_26.$$p = null;
      num = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
      if (($yield !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_27 = function(){var self = TMP_27.$$s || this;

        return binomial_coefficient(self.length, num);}, TMP_27.$$s = self, TMP_27.$$arity = 0, TMP_27), $a).call($b, "combination", num)
      };
      
      var i, length, stack, chosen, lev, done, next;

      if (num === 0) {
        Opal.yield1($yield, [])
      } else if (num === 1) {
        for (i = 0, length = self.length; i < length; i++) {
          Opal.yield1($yield, [self[i]])
        }
      }
      else if (num === self.length) {
        Opal.yield1($yield, self.slice())
      }
      else if (num >= 0 && num < self.length) {
        stack = [];
        for (i = 0; i <= num + 1; i++) {
          stack.push(0);
        }

        chosen = [];
        lev = 0;
        done = false;
        stack[0] = -1;

        while (!done) {
          chosen[lev] = self[stack[lev+1]];
          while (lev < num - 1) {
            lev++;
            next = stack[lev+1] = stack[lev] + 1;
            chosen[lev] = self[next];
          }
          Opal.yield1($yield, chosen.slice())
          lev++;
          do {
            done = (lev === 0);
            stack[lev]++;
            lev--;
          } while ( stack[lev+1] + num === self.length + lev + 1 );
        }
      }
    ;
      return self;
    }, TMP_26.$$arity = 1);

    Opal.defn(self, '$repeated_combination', TMP_28 = function $$repeated_combination(n) {
      var $a, $b, TMP_29, self = this, $iter = TMP_28.$$p, $yield = $iter || nil, num = nil;

      TMP_28.$$p = null;
      num = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
      if (($yield !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_29 = function(){var self = TMP_29.$$s || this;

        return binomial_coefficient(self.length + num - 1, num);}, TMP_29.$$s = self, TMP_29.$$arity = 0, TMP_29), $a).call($b, "repeated_combination", num)
      };
      
      function iterate(max, from, buffer, self) {
        if (buffer.length == max) {
          var copy = buffer.slice();
          Opal.yield1($yield, copy)
          return;
        }
        for (var i = from; i < self.length; i++) {
          buffer.push(self[i]);
          iterate(max, i, buffer, self);
          buffer.pop();
        }
      }

      if (num >= 0) {
        iterate(num, 0, [], self);
      }
    
      return self;
    }, TMP_28.$$arity = 1);

    Opal.defn(self, '$compact', TMP_30 = function $$compact() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length, item; i < length; i++) {
        if ((item = self[i]) !== nil) {
          result.push(item);
        }
      }

      return result;
    
    }, TMP_30.$$arity = 0);

    Opal.defn(self, '$compact!', TMP_31 = function() {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = self.length; i < length; i++) {
        if (self[i] === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    }, TMP_31.$$arity = 0);

    Opal.defn(self, '$concat', TMP_32 = function $$concat(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      for (var i = 0, length = other.length; i < length; i++) {
        self.push(other[i]);
      }
    
      return self;
    }, TMP_32.$$arity = 1);

    Opal.defn(self, '$delete', TMP_33 = function(object) {
      var self = this, $iter = TMP_33.$$p, $yield = $iter || nil;

      TMP_33.$$p = null;
      
      var original = self.length;

      for (var i = 0, length = original; i < length; i++) {
        if ((self[i])['$=='](object)) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      if (self.length === original) {
        if (($yield !== nil)) {
          return Opal.yieldX($yield, []);
        }
        return nil;
      }
      return object;
    ;
    }, TMP_33.$$arity = 1);

    Opal.defn(self, '$delete_at', TMP_34 = function $$delete_at(index) {
      var self = this;

      
      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      var result = self[index];

      self.splice(index, 1);

      return result;
    ;
    }, TMP_34.$$arity = 1);

    Opal.defn(self, '$delete_if', TMP_35 = function $$delete_if() {
      var $a, $b, TMP_36, self = this, $iter = TMP_35.$$p, block = $iter || nil;

      TMP_35.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_36 = function(){var self = TMP_36.$$s || this;

        return self.$size()}, TMP_36.$$s = self, TMP_36.$$arity = 0, TMP_36), $a).call($b, "delete_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        value = block(self[i]);

        if (value !== false && value !== nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    }, TMP_35.$$arity = 0);

    Opal.defn(self, '$drop', TMP_37 = function $$drop(number) {
      var self = this;

      
      if (number < 0) {
        self.$raise($scope.get('ArgumentError'))
      }

      return self.slice(number);
    ;
    }, TMP_37.$$arity = 1);

    Opal.defn(self, '$dup', TMP_38 = function $$dup() {
      var $a, $b, self = this, $iter = TMP_38.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_38.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      
      if (
        self.$$class === Opal.Array &&
        self.$allocate.$$pristine &&
        self.$copy_instance_variables.$$pristine &&
        self.$initialize_dup.$$pristine
      ) return self.slice(0);
    
      return ($a = ($b = self, Opal.find_super_dispatcher(self, 'dup', TMP_38, false)), $a.$$p = $iter, $a).apply($b, $zuper);
    }, TMP_38.$$arity = 0);

    Opal.defn(self, '$each', TMP_39 = function $$each() {
      var $a, $b, TMP_40, self = this, $iter = TMP_39.$$p, block = $iter || nil;

      TMP_39.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_40 = function(){var self = TMP_40.$$s || this;

        return self.$size()}, TMP_40.$$s = self, TMP_40.$$arity = 0, TMP_40), $a).call($b, "each")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);
      }
    
      return self;
    }, TMP_39.$$arity = 0);

    Opal.defn(self, '$each_index', TMP_41 = function $$each_index() {
      var $a, $b, TMP_42, self = this, $iter = TMP_41.$$p, block = $iter || nil;

      TMP_41.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_42 = function(){var self = TMP_42.$$s || this;

        return self.$size()}, TMP_42.$$s = self, TMP_42.$$arity = 0, TMP_42), $a).call($b, "each_index")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, i);
      }
    
      return self;
    }, TMP_41.$$arity = 0);

    Opal.defn(self, '$empty?', TMP_43 = function() {
      var self = this;

      return self.length === 0;
    }, TMP_43.$$arity = 0);

    Opal.defn(self, '$eql?', TMP_44 = function(other) {
      var self = this;

      
      var recursed = {};

      function _eql(array, other) {
        var i, length, a, b;

        if (!other.$$is_array) {
          return false;
        }

        other = other.$to_a();

        if (array.length !== other.length) {
          return false;
        }

        recursed[(array).$object_id()] = true;

        for (i = 0, length = array.length; i < length; i++) {
          a = array[i];
          b = other[i];
          if (a.$$is_array) {
            if (b.$$is_array && b.length !== a.length) {
              return false;
            }
            if (!recursed.hasOwnProperty((a).$object_id())) {
              if (!_eql(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$eql?'](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eql(self, other);
    
    }, TMP_44.$$arity = 1);

    Opal.defn(self, '$fetch', TMP_45 = function $$fetch(index, defaults) {
      var self = this, $iter = TMP_45.$$p, block = $iter || nil;

      TMP_45.$$p = null;
      
      var original = index;

      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index >= 0 && index < self.length) {
        return self[index];
      }

      if (block !== nil) {
        return block(original);
      }

      if (defaults != null) {
        return defaults;
      }

      if (self.length === 0) {
        self.$raise($scope.get('IndexError'), "index " + (original) + " outside of array bounds: 0...0")
      }
      else {
        self.$raise($scope.get('IndexError'), "index " + (original) + " outside of array bounds: -" + (self.length) + "..." + (self.length));
      }
    ;
    }, TMP_45.$$arity = -2);

    Opal.defn(self, '$fill', TMP_46 = function $$fill($a_rest) {
      var $b, $c, self = this, args, $iter = TMP_46.$$p, block = $iter || nil, one = nil, two = nil, obj = nil, left = nil, right = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_46.$$p = null;
      
      var i, length, value;
    
      if (block !== false && block !== nil && block != null) {
        if ((($b = args.length > 2) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 0..2)")};
        $c = args, $b = Opal.to_ary($c), one = ($b[0] == null ? nil : $b[0]), two = ($b[1] == null ? nil : $b[1]), $c;
        } else {
        if ((($b = args.length == 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        } else if ((($b = args.length > 3) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 1..3)")};
        $c = args, $b = Opal.to_ary($c), obj = ($b[0] == null ? nil : $b[0]), one = ($b[1] == null ? nil : $b[1]), two = ($b[2] == null ? nil : $b[2]), $c;
      };
      if ((($b = $scope.get('Range')['$==='](one)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        if (two !== false && two !== nil && two != null) {
          self.$raise($scope.get('TypeError'), "length invalid with range")};
        left = $scope.get('Opal').$coerce_to(one.$begin(), $scope.get('Integer'), "to_int");
        if ((($b = left < 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          left += self.length;};
        if ((($b = left < 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          self.$raise($scope.get('RangeError'), "" + (one.$inspect()) + " out of range")};
        right = $scope.get('Opal').$coerce_to(one.$end(), $scope.get('Integer'), "to_int");
        if ((($b = right < 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          right += self.length;};
        if ((($b = one['$exclude_end?']()) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          } else {
          right += 1;
        };
        if ((($b = right <= left) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          return self};
      } else if (one !== false && one !== nil && one != null) {
        left = $scope.get('Opal').$coerce_to(one, $scope.get('Integer'), "to_int");
        if ((($b = left < 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          left += self.length;};
        if ((($b = left < 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          left = 0};
        if (two !== false && two !== nil && two != null) {
          right = $scope.get('Opal').$coerce_to(two, $scope.get('Integer'), "to_int");
          if ((($b = right == 0) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
            return self};
          right += left;
          } else {
          right = self.length
        };
        } else {
        left = 0;
        right = self.length;
      };
      if ((($b = left > self.length) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        
        for (i = self.length; i < right; i++) {
          self[i] = nil;
        }
      ;};
      if ((($b = right > self.length) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        self.length = right};
      if (block !== false && block !== nil && block != null) {
        
        for (length = self.length; left < right; left++) {
          value = block(left);
          self[left] = value;
        }
      ;
        } else {
        
        for (length = self.length; left < right; left++) {
          self[left] = obj;
        }
      ;
      };
      return self;
    }, TMP_46.$$arity = -1);

    Opal.defn(self, '$first', TMP_47 = function $$first(count) {
      var self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[0];
      }

      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative array size");
      }

      return self.slice(0, count);
    
    }, TMP_47.$$arity = -1);

    Opal.defn(self, '$flatten', TMP_48 = function $$flatten(level) {
      var self = this;

      
      function _flatten(array, level) {
        var result = [],
            i, length,
            item, ary;

        array = (array).$to_a();

        for (i = 0, length = array.length; i < length; i++) {
          item = array[i];

          if (!$scope.get('Opal')['$respond_to?'](item, "to_ary")) {
            result.push(item);
            continue;
          }

          ary = (item).$to_ary();

          if (ary === nil) {
            result.push(item);
            continue;
          }

          if (!ary.$$is_array) {
            self.$raise($scope.get('TypeError'));
          }

          if (ary === self) {
            self.$raise($scope.get('ArgumentError'));
          }

          switch (level) {
          case undefined:
            result = result.concat(_flatten(ary));
            break;
          case 0:
            result.push(ary);
            break;
          default:
            result.push.apply(result, _flatten(ary, level - 1));
          }
        }
        return result;
      }

      if (level !== undefined) {
        level = $scope.get('Opal').$coerce_to(level, $scope.get('Integer'), "to_int");
      }

      return toArraySubclass(_flatten(self, level), self.$class());
    
    }, TMP_48.$$arity = -1);

    Opal.defn(self, '$flatten!', TMP_49 = function(level) {
      var self = this;

      
      var flattened = self.$flatten(level);

      if (self.length == flattened.length) {
        for (var i = 0, length = self.length; i < length; i++) {
          if (self[i] !== flattened[i]) {
            break;
          }
        }

        if (i == length) {
          return nil;
        }
      }

      self.$replace(flattened);
    ;
      return self;
    }, TMP_49.$$arity = -1);

    Opal.defn(self, '$hash', TMP_50 = function $$hash() {
      var self = this;

      
      var top = (Opal.hash_ids == undefined),
          result = ['A'],
          hash_id = self.$object_id(),
          item, i, key;

      try {
        if (top) {
          Opal.hash_ids = {};
        }

        if (Opal.hash_ids.hasOwnProperty(hash_id)) {
          return 'self';
        }

        for (key in Opal.hash_ids) {
          if (Opal.hash_ids.hasOwnProperty(key)) {
            item = Opal.hash_ids[key];
            if (self['$eql?'](item)) {
              return 'self';
            }
          }
        }

        Opal.hash_ids[hash_id] = self;

        for (i = 0; i < self.length; i++) {
          item = self[i];
          result.push(item.$hash());
        }

        return result.join(',');
      } finally {
        if (top) {
          delete Opal.hash_ids;
        }
      }
    
    }, TMP_50.$$arity = 0);

    Opal.defn(self, '$include?', TMP_51 = function(member) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        if ((self[i])['$=='](member)) {
          return true;
        }
      }

      return false;
    
    }, TMP_51.$$arity = 1);

    Opal.defn(self, '$index', TMP_52 = function $$index(object) {
      var self = this, $iter = TMP_52.$$p, block = $iter || nil;

      TMP_52.$$p = null;
      
      var i, length, value;

      if (object != null) {
        for (i = 0, length = self.length; i < length; i++) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (i = 0, length = self.length; i < length; i++) {
          value = block(self[i]);

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else {
        return self.$enum_for("index");
      }

      return nil;
    
    }, TMP_52.$$arity = -1);

    Opal.defn(self, '$insert', TMP_53 = function $$insert(index, $a_rest) {
      var self = this, objects;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      objects = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        objects[$arg_idx - 1] = arguments[$arg_idx];
      }
      
      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (objects.length > 0) {
        if (index < 0) {
          index += self.length + 1;

          if (index < 0) {
            self.$raise($scope.get('IndexError'), "" + (index) + " is out of bounds");
          }
        }
        if (index > self.length) {
          for (var i = self.length; i < index; i++) {
            self.push(nil);
          }
        }

        self.splice.apply(self, [index, 0].concat(objects));
      }
    ;
      return self;
    }, TMP_53.$$arity = -2);

    Opal.defn(self, '$inspect', TMP_54 = function $$inspect() {
      var self = this;

      
      var result = [],
          id     = self.$__id__();

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self['$[]'](i);

        if ((item).$__id__() === id) {
          result.push('[...]');
        }
        else {
          result.push((item).$inspect());
        }
      }

      return '[' + result.join(', ') + ']';
    ;
    }, TMP_54.$$arity = 0);

    Opal.defn(self, '$join', TMP_55 = function $$join(sep) {
      var $a, self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      if (sep == null) {
        sep = nil;
      }
      if ((($a = self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ""};
      if ((($a = sep === nil) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        sep = $gvars[","]};
      
      var result = [];
      var i, length, item, tmp;

      for (i = 0, length = self.length; i < length; i++) {
        item = self[i];

        if ($scope.get('Opal')['$respond_to?'](item, "to_str")) {
          tmp = (item).$to_str();

          if (tmp !== nil) {
            result.push((tmp).$to_s());

            continue;
          }
        }

        if ($scope.get('Opal')['$respond_to?'](item, "to_ary")) {
          tmp = (item).$to_ary();

          if (tmp === self) {
            self.$raise($scope.get('ArgumentError'));
          }

          if (tmp !== nil) {
            result.push((tmp).$join(sep));

            continue;
          }
        }

        if ($scope.get('Opal')['$respond_to?'](item, "to_s")) {
          tmp = (item).$to_s();

          if (tmp !== nil) {
            result.push(tmp);

            continue;
          }
        }

        self.$raise($scope.get('NoMethodError').$new("" + ($scope.get('Opal').$inspect(item)) + " doesn't respond to #to_str, #to_ary or #to_s", "to_str"));
      }

      if (sep === nil) {
        return result.join('');
      }
      else {
        return result.join($scope.get('Opal')['$coerce_to!'](sep, $scope.get('String'), "to_str").$to_s());
      }
    ;
    }, TMP_55.$$arity = -1);

    Opal.defn(self, '$keep_if', TMP_56 = function $$keep_if() {
      var $a, $b, TMP_57, self = this, $iter = TMP_56.$$p, block = $iter || nil;

      TMP_56.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_57 = function(){var self = TMP_57.$$s || this;

        return self.$size()}, TMP_57.$$s = self, TMP_57.$$arity = 0, TMP_57), $a).call($b, "keep_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        value = block(self[i]);

        if (value === false || value === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    }, TMP_56.$$arity = 0);

    Opal.defn(self, '$last', TMP_58 = function $$last(count) {
      var self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[self.length - 1];
      }

      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative array size");
      }

      if (count > self.length) {
        count = self.length;
      }

      return self.slice(self.length - count, self.length);
    
    }, TMP_58.$$arity = -1);

    Opal.defn(self, '$length', TMP_59 = function $$length() {
      var self = this;

      return self.length;
    }, TMP_59.$$arity = 0);

    Opal.alias(self, 'map', 'collect');

    Opal.alias(self, 'map!', 'collect!');

    
    // Returns the product of from, from-1, ..., from - how_many + 1.
    function descending_factorial(from, how_many) {
      var count = how_many >= 0 ? 1 : 0;
      while (how_many) {
        count *= from;
        from--;
        how_many--;
      }
      return count;
    }
  

    Opal.defn(self, '$permutation', TMP_60 = function $$permutation(num) {
      var $a, $b, TMP_61, self = this, $iter = TMP_60.$$p, block = $iter || nil, perm = nil, used = nil;

      TMP_60.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_61 = function(){var self = TMP_61.$$s || this;

        return descending_factorial(self.length, num === undefined ? self.length : num);}, TMP_61.$$s = self, TMP_61.$$arity = 0, TMP_61), $a).call($b, "permutation", num)
      };
      
      var permute, offensive, output;

      if (num === undefined) {
        num = self.length;
      }
      else {
        num = $scope.get('Opal').$coerce_to(num, $scope.get('Integer'), "to_int")
      }

      if (num < 0 || self.length < num) {
        // no permutations, yield nothing
      }
      else if (num === 0) {
        // exactly one permutation: the zero-length array
        Opal.yield1(block, [])
      }
      else if (num === 1) {
        // this is a special, easy case
        for (var i = 0; i < self.length; i++) {
          Opal.yield1(block, [self[i]])
        }
      }
      else {
        // this is the general case
        perm = $scope.get('Array').$new(num)
        used = $scope.get('Array').$new(self.length, false)

        permute = function(num, perm, index, used, blk) {
          self = this;
          for(var i = 0; i < self.length; i++){
            if(used['$[]'](i)['$!']()) {
              perm[index] = i;
              if(index < num - 1) {
                used[i] = true;
                permute.call(self, num, perm, index + 1, used, blk);
                used[i] = false;
              }
              else {
                output = [];
                for (var j = 0; j < perm.length; j++) {
                  output.push(self[perm[j]]);
                }
                Opal.yield1(blk, output);
              }
            }
          }
        }

        if ((block !== nil)) {
          // offensive (both definitions) copy.
          offensive = self.slice();
          permute.call(offensive, num, perm, 0, used, block);
        }
        else {
          permute.call(self, num, perm, 0, used, block);
        }
      }
    ;
      return self;
    }, TMP_60.$$arity = -1);

    Opal.defn(self, '$repeated_permutation', TMP_62 = function $$repeated_permutation(n) {
      var $a, $b, TMP_63, self = this, $iter = TMP_62.$$p, $yield = $iter || nil, num = nil;

      TMP_62.$$p = null;
      num = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
      if (($yield !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_63 = function(){var self = TMP_63.$$s || this, $c;

        if ((($c = $rb_ge(num, 0)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return self.$size()['$**'](num)
            } else {
            return 0
          }}, TMP_63.$$s = self, TMP_63.$$arity = 0, TMP_63), $a).call($b, "repeated_permutation", num)
      };
      
      function iterate(max, buffer, self) {
        if (buffer.length == max) {
          var copy = buffer.slice();
          Opal.yield1($yield, copy)
          return;
        }
        for (var i = 0; i < self.length; i++) {
          buffer.push(self[i]);
          iterate(max, buffer, self);
          buffer.pop();
        }
      }

      iterate(num, [], self.slice());
    
      return self;
    }, TMP_62.$$arity = 1);

    Opal.defn(self, '$pop', TMP_64 = function $$pop(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return self.pop();};
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
      if ((($a = count < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      if ((($a = self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = count > self.length) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.splice(0, self.length);
        } else {
        return self.splice(self.length - count, self.length);
      };
    }, TMP_64.$$arity = -1);

    Opal.defn(self, '$product', TMP_65 = function $$product($a_rest) {
      var self = this, args, $iter = TMP_65.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_65.$$p = null;
      
      var result = (block !== nil) ? null : [],
          n = args.length + 1,
          counters = new Array(n),
          lengths  = new Array(n),
          arrays   = new Array(n),
          i, m, subarray, len, resultlen = 1;

      arrays[0] = self;
      for (i = 1; i < n; i++) {
        arrays[i] = $scope.get('Opal').$coerce_to(args[i - 1], $scope.get('Array'), "to_ary");
      }

      for (i = 0; i < n; i++) {
        len = arrays[i].length;
        if (len === 0) {
          return result || self;
        }
        resultlen *= len;
        if (resultlen > 2147483647) {
          self.$raise($scope.get('RangeError'), "too big to product")
        }
        lengths[i] = len;
        counters[i] = 0;
      }

      outer_loop: for (;;) {
        subarray = [];
        for (i = 0; i < n; i++) {
          subarray.push(arrays[i][counters[i]]);
        }
        if (result) {
          result.push(subarray);
        } else {
          Opal.yield1(block, subarray)
        }
        m = n - 1;
        counters[m]++;
        while (counters[m] === lengths[m]) {
          counters[m] = 0;
          if (--m < 0) break outer_loop;
          counters[m]++;
        }
      }

      return result || self;
    ;
    }, TMP_65.$$arity = -1);

    Opal.defn(self, '$push', TMP_66 = function $$push($a_rest) {
      var self = this, objects;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      objects = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        objects[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = 0, length = objects.length; i < length; i++) {
        self.push(objects[i]);
      }
    
      return self;
    }, TMP_66.$$arity = -1);

    Opal.defn(self, '$rassoc', TMP_67 = function $$rassoc(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        item = self[i];

        if (item.length && item[1] !== undefined) {
          if ((item[1])['$=='](object)) {
            return item;
          }
        }
      }

      return nil;
    
    }, TMP_67.$$arity = 1);

    Opal.defn(self, '$reject', TMP_68 = function $$reject() {
      var $a, $b, TMP_69, self = this, $iter = TMP_68.$$p, block = $iter || nil;

      TMP_68.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_69 = function(){var self = TMP_69.$$s || this;

        return self.$size()}, TMP_69.$$s = self, TMP_69.$$arity = 0, TMP_69), $a).call($b, "reject")
      };
      
      var result = [];

      for (var i = 0, length = self.length, value; i < length; i++) {
        value = block(self[i]);

        if (value === false || value === nil) {
          result.push(self[i]);
        }
      }
      return result;
    
    }, TMP_68.$$arity = 0);

    Opal.defn(self, '$reject!', TMP_70 = function() {
      var $a, $b, TMP_71, $c, self = this, $iter = TMP_70.$$p, block = $iter || nil, original = nil;

      TMP_70.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_71 = function(){var self = TMP_71.$$s || this;

        return self.$size()}, TMP_71.$$s = self, TMP_71.$$arity = 0, TMP_71), $a).call($b, "reject!")
      };
      original = self.$length();
      ($a = ($c = self).$delete_if, $a.$$p = block.$to_proc(), $a).call($c);
      if (self.$length()['$=='](original)) {
        return nil
        } else {
        return self
      };
    }, TMP_70.$$arity = 0);

    Opal.defn(self, '$replace', TMP_72 = function $$replace(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      self.splice(0, self.length);
      self.push.apply(self, other);
    
      return self;
    }, TMP_72.$$arity = 1);

    Opal.defn(self, '$reverse', TMP_73 = function $$reverse() {
      var self = this;

      return self.slice(0).reverse();
    }, TMP_73.$$arity = 0);

    Opal.defn(self, '$reverse!', TMP_74 = function() {
      var self = this;

      return self.reverse();
    }, TMP_74.$$arity = 0);

    Opal.defn(self, '$reverse_each', TMP_75 = function $$reverse_each() {
      var $a, $b, TMP_76, $c, self = this, $iter = TMP_75.$$p, block = $iter || nil;

      TMP_75.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_76 = function(){var self = TMP_76.$$s || this;

        return self.$size()}, TMP_76.$$s = self, TMP_76.$$arity = 0, TMP_76), $a).call($b, "reverse_each")
      };
      ($a = ($c = self.$reverse()).$each, $a.$$p = block.$to_proc(), $a).call($c);
      return self;
    }, TMP_75.$$arity = 0);

    Opal.defn(self, '$rindex', TMP_77 = function $$rindex(object) {
      var self = this, $iter = TMP_77.$$p, block = $iter || nil;

      TMP_77.$$p = null;
      
      var i, value;

      if (object != null) {
        for (i = self.length - 1; i >= 0; i--) {
          if (i >= self.length) {
            break;
          }
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (i = self.length - 1; i >= 0; i--) {
          if (i >= self.length) {
            break;
          }

          value = block(self[i]);

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else if (object == null) {
        return self.$enum_for("rindex");
      }

      return nil;
    
    }, TMP_77.$$arity = -1);

    Opal.defn(self, '$rotate', TMP_78 = function $$rotate(n) {
      var self = this;

      if (n == null) {
        n = 1;
      }
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
      
      var ary, idx, firstPart, lastPart;

      if (self.length === 1) {
        return self.slice();
      }
      if (self.length === 0) {
        return [];
      }

      ary = self.slice();
      idx = n % ary.length;

      firstPart = ary.slice(idx);
      lastPart = ary.slice(0, idx);
      return firstPart.concat(lastPart);
    
    }, TMP_78.$$arity = -1);

    Opal.defn(self, '$rotate!', TMP_79 = function(cnt) {
      var self = this, ary = nil;

      if (cnt == null) {
        cnt = 1;
      }
      
      if (self.length === 0 || self.length === 1) {
        return self;
      }
    
      cnt = $scope.get('Opal').$coerce_to(cnt, $scope.get('Integer'), "to_int");
      ary = self.$rotate(cnt);
      return self.$replace(ary);
    }, TMP_79.$$arity = -1);

    (function($base, $super) {
      function $SampleRandom(){};
      var self = $SampleRandom = $klass($base, $super, 'SampleRandom', $SampleRandom);

      var def = self.$$proto, $scope = self.$$scope, TMP_80, TMP_81;

      def.rng = nil;
      Opal.defn(self, '$initialize', TMP_80 = function $$initialize(rng) {
        var self = this;

        return self.rng = rng;
      }, TMP_80.$$arity = 1);

      return (Opal.defn(self, '$rand', TMP_81 = function $$rand(size) {
        var $a, self = this, random = nil;

        random = $scope.get('Opal').$coerce_to(self.rng.$rand(size), $scope.get('Integer'), "to_int");
        if ((($a = random < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('RangeError'), "random value must be >= 0")};
        if ((($a = random < size) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.$raise($scope.get('RangeError'), "random value must be less than Array size")
        };
        return random;
      }, TMP_81.$$arity = 1), nil) && 'rand';
    })($scope.base, null);

    Opal.defn(self, '$sample', TMP_82 = function $$sample(count, options) {
      var $a, $b, self = this, o = nil, rng = nil;

      if ((($a = count === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$at($scope.get('Kernel').$rand(self.length))};
      if ((($a = options === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = (o = $scope.get('Opal')['$coerce_to?'](count, $scope.get('Hash'), "to_hash"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          options = o;
          count = nil;
          } else {
          options = nil;
          count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
        }
        } else {
        count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
        options = $scope.get('Opal').$coerce_to(options, $scope.get('Hash'), "to_hash");
      };
      if ((($a = (($b = count !== false && count !== nil && count != null) ? count < 0 : count)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "count must be greater than 0")};
      if (options !== false && options !== nil && options != null) {
        rng = options['$[]']("random")};
      if ((($a = (($b = rng !== false && rng !== nil && rng != null) ? rng['$respond_to?']("rand") : rng)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        rng = $scope.get('SampleRandom').$new(rng)
        } else {
        rng = $scope.get('Kernel')
      };
      if (count !== false && count !== nil && count != null) {
        } else {
        return self[rng.$rand(self.length)]
      };
      

      var abandon, spin, result, i, j, k, targetIndex, oldValue;

      if (count > self.length) {
        count = self.length;
      }

      switch (count) {
        case 0:
          return [];
          break;
        case 1:
          return [self[rng.$rand(self.length)]];
          break;
        case 2:
          i = rng.$rand(self.length);
          j = rng.$rand(self.length);
          if (i === j) {
            j = i === 0 ? i + 1 : i - 1;
          }
          return [self[i], self[j]];
          break;
        default:
          if (self.length / count > 3) {
            abandon = false;
            spin = 0;

            result = $scope.get('Array').$new(count);
            i = 1;

            result[0] = rng.$rand(self.length);
            while (i < count) {
              k = rng.$rand(self.length);
              j = 0;

              while (j < i) {
                while (k === result[j]) {
                  spin++;
                  if (spin > 100) {
                    abandon = true;
                    break;
                  }
                  k = rng.$rand(self.length);
                }
                if (abandon) { break; }

                j++;
              }

              if (abandon) { break; }

              result[i] = k;

              i++;
            }

            if (!abandon) {
              i = 0;
              while (i < count) {
                result[i] = self[result[i]];
                i++;
              }

              return result;
            }
          }

          result = self.slice();

          for (var c = 0; c < count; c++) {
            targetIndex = rng.$rand(self.length);
            oldValue = result[c];
            result[c] = result[targetIndex];
            result[targetIndex] = oldValue;
          }

          return count === self.length ? result : (result)['$[]'](0, count);
      }
    
    }, TMP_82.$$arity = -1);

    Opal.defn(self, '$select', TMP_83 = function $$select() {
      var $a, $b, TMP_84, self = this, $iter = TMP_83.$$p, block = $iter || nil;

      TMP_83.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_84 = function(){var self = TMP_84.$$s || this;

        return self.$size()}, TMP_84.$$s = self, TMP_84.$$arity = 0, TMP_84), $a).call($b, "select")
      };
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        value = Opal.yield1(block, item);

        if (value !== false && value !== nil) {
          result.push(item);
        }
      }

      return result;
    
    }, TMP_83.$$arity = 0);

    Opal.defn(self, '$select!', TMP_85 = function() {
      var $a, $b, TMP_86, $c, self = this, $iter = TMP_85.$$p, block = $iter || nil;

      TMP_85.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_86 = function(){var self = TMP_86.$$s || this;

        return self.$size()}, TMP_86.$$s = self, TMP_86.$$arity = 0, TMP_86), $a).call($b, "select!")
      };
      
      var original = self.length;
      ($a = ($c = self).$keep_if, $a.$$p = block.$to_proc(), $a).call($c);
      return self.length === original ? nil : self;
    
    }, TMP_85.$$arity = 0);

    Opal.defn(self, '$shift', TMP_87 = function $$shift(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return self.shift();};
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
      if ((($a = count < 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      if ((($a = self.length === 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return []};
      return self.splice(0, count);
    }, TMP_87.$$arity = -1);

    Opal.alias(self, 'size', 'length');

    Opal.defn(self, '$shuffle', TMP_88 = function $$shuffle(rng) {
      var self = this;

      return self.$dup().$to_a()['$shuffle!'](rng);
    }, TMP_88.$$arity = -1);

    Opal.defn(self, '$shuffle!', TMP_89 = function(rng) {
      var self = this;

      
      var randgen, i = self.length, j, tmp;

      if (rng !== undefined) {
        rng = $scope.get('Opal')['$coerce_to?'](rng, $scope.get('Hash'), "to_hash");

        if (rng !== nil) {
          rng = rng['$[]']("random");

          if (rng !== nil && rng['$respond_to?']("rand")) {
            randgen = rng;
          }
        }
      }

      while (i) {
        if (randgen) {
          j = randgen.$rand(i).$to_int();

          if (j < 0) {
            self.$raise($scope.get('RangeError'), "random number too small " + (j))
          }

          if (j >= i) {
            self.$raise($scope.get('RangeError'), "random number too big " + (j))
          }
        }
        else {
          j = Math.floor(Math.random() * i);
        }

        tmp = self[--i];
        self[i] = self[j];
        self[j] = tmp;
      }

      return self;
    ;
    }, TMP_89.$$arity = -1);

    Opal.alias(self, 'slice', '[]');

    Opal.defn(self, '$slice!', TMP_90 = function(index, length) {
      var $a, self = this, result = nil, range = nil, range_start = nil, range_end = nil, start = nil;

      result = nil;
      if ((($a = length === undefined) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Range')['$==='](index)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          range = index;
          result = self['$[]'](range);
          range_start = $scope.get('Opal').$coerce_to(range.$begin(), $scope.get('Integer'), "to_int");
          range_end = $scope.get('Opal').$coerce_to(range.$end(), $scope.get('Integer'), "to_int");
          
          if (range_start < 0) {
            range_start += self.length;
          }

          if (range_end < 0) {
            range_end += self.length;
          } else if (range_end >= self.length) {
            range_end = self.length - 1;
            if (range.exclude) {
              range_end += 1;
            }
          }

          var range_length = range_end - range_start;
          if (range.exclude) {
            range_end -= 1;
          } else {
            range_length += 1;
          }

          if (range_start < self.length && range_start >= 0 && range_end < self.length && range_end >= 0 && range_length > 0) {
            self.splice(range_start, range_length);
          }
        
          } else {
          start = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
          
          if (start < 0) {
            start += self.length;
          }

          if (start < 0 || start >= self.length) {
            return nil;
          }

          result = self[start];

          if (start === 0) {
            self.shift();
          } else {
            self.splice(start, 1);
          }
        
        }
        } else {
        start = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
        length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");
        
        if (length < 0) {
          return nil;
        }

        var end = start + length;

        result = self['$[]'](start, length);

        if (start < 0) {
          start += self.length;
        }

        if (start + length > self.length) {
          length = self.length - start;
        }

        if (start < self.length && start >= 0) {
          self.splice(start, length);
        }
      
      };
      return result;
    }, TMP_90.$$arity = -2);

    Opal.defn(self, '$sort', TMP_91 = function $$sort() {
      var $a, self = this, $iter = TMP_91.$$p, block = $iter || nil;

      TMP_91.$$p = null;
      if ((($a = self.length > 1) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return self
      };
      
      if (block === nil) {
        block = function(a, b) {
          return (a)['$<=>'](b);
        };
      }

      return self.slice().sort(function(x, y) {
        var ret = block(x, y);

        if (ret === nil) {
          self.$raise($scope.get('ArgumentError'), "comparison of " + ((x).$inspect()) + " with " + ((y).$inspect()) + " failed");
        }

        return $rb_gt(ret, 0) ? 1 : ($rb_lt(ret, 0) ? -1 : 0);
      });
    ;
    }, TMP_91.$$arity = 0);

    Opal.defn(self, '$sort!', TMP_92 = function() {
      var $a, $b, self = this, $iter = TMP_92.$$p, block = $iter || nil;

      TMP_92.$$p = null;
      
      var result;

      if ((block !== nil)) {
        result = ($a = ($b = (self.slice())).$sort, $a.$$p = block.$to_proc(), $a).call($b);
      }
      else {
        result = (self.slice()).$sort();
      }

      self.length = 0;
      for(var i = 0, length = result.length; i < length; i++) {
        self.push(result[i]);
      }

      return self;
    ;
    }, TMP_92.$$arity = 0);

    Opal.defn(self, '$sort_by!', TMP_93 = function() {
      var $a, $b, TMP_94, $c, self = this, $iter = TMP_93.$$p, block = $iter || nil;

      TMP_93.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_94 = function(){var self = TMP_94.$$s || this;

        return self.$size()}, TMP_94.$$s = self, TMP_94.$$arity = 0, TMP_94), $a).call($b, "sort_by!")
      };
      return self.$replace(($a = ($c = self).$sort_by, $a.$$p = block.$to_proc(), $a).call($c));
    }, TMP_93.$$arity = 0);

    Opal.defn(self, '$take', TMP_95 = function $$take(count) {
      var self = this;

      
      if (count < 0) {
        self.$raise($scope.get('ArgumentError'));
      }

      return self.slice(0, count);
    ;
    }, TMP_95.$$arity = 1);

    Opal.defn(self, '$take_while', TMP_96 = function $$take_while() {
      var self = this, $iter = TMP_96.$$p, block = $iter || nil;

      TMP_96.$$p = null;
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        value = block(item);

        if (value === false || value === nil) {
          return result;
        }

        result.push(item);
      }

      return result;
    
    }, TMP_96.$$arity = 0);

    Opal.defn(self, '$to_a', TMP_97 = function $$to_a() {
      var self = this;

      return self;
    }, TMP_97.$$arity = 0);

    Opal.alias(self, 'to_ary', 'to_a');

    Opal.defn(self, '$to_h', TMP_98 = function $$to_h() {
      var self = this;

      
      var i, len = self.length, ary, key, val, hash = $hash2([], {});

      for (i = 0; i < len; i++) {
        ary = $scope.get('Opal')['$coerce_to?'](self[i], $scope.get('Array'), "to_ary");
        if (!ary.$$is_array) {
          self.$raise($scope.get('TypeError'), "wrong element type " + ((ary).$class()) + " at " + (i) + " (expected array)")
        }
        if (ary.length !== 2) {
          self.$raise($scope.get('ArgumentError'), "wrong array length at " + (i) + " (expected 2, was " + ((ary).$length()) + ")")
        }
        key = ary[0];
        val = ary[1];
        Opal.hash_put(hash, key, val);
      }

      return hash;
    ;
    }, TMP_98.$$arity = 0);

    Opal.alias(self, 'to_s', 'inspect');

    Opal.defn(self, '$transpose', TMP_101 = function $$transpose() {
      var $a, $b, TMP_99, self = this, result = nil, max = nil;

      if ((($a = self['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return []};
      result = [];
      max = nil;
      ($a = ($b = self).$each, $a.$$p = (TMP_99 = function(row){var self = TMP_99.$$s || this, $c, $d, TMP_100;
if (row == null) row = nil;
      if ((($c = $scope.get('Array')['$==='](row)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
          row = row.$to_a()
          } else {
          row = $scope.get('Opal').$coerce_to(row, $scope.get('Array'), "to_ary").$to_a()
        };
        ((($c = max) !== false && $c !== nil && $c != null) ? $c : max = row.length);
        if ((($c = (row.length)['$!='](max)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
          self.$raise($scope.get('IndexError'), "element size differs (" + (row.length) + " should be " + (max))};
        return ($c = ($d = (row.length)).$times, $c.$$p = (TMP_100 = function(i){var self = TMP_100.$$s || this, $e, $f, $g, entry = nil;
if (i == null) i = nil;
        entry = (($e = i, $f = result, ((($g = $f['$[]']($e)) !== false && $g !== nil && $g != null) ? $g : $f['$[]=']($e, []))));
          return entry['$<<'](row.$at(i));}, TMP_100.$$s = self, TMP_100.$$arity = 1, TMP_100), $c).call($d);}, TMP_99.$$s = self, TMP_99.$$arity = 1, TMP_99), $a).call($b);
      return result;
    }, TMP_101.$$arity = 0);

    Opal.defn(self, '$uniq', TMP_102 = function $$uniq() {
      var self = this, $iter = TMP_102.$$p, block = $iter || nil;

      TMP_102.$$p = null;
      
      var hash = $hash2([], {}), i, length, item, key;

      if (block === nil) {
        for (i = 0, length = self.length; i < length; i++) {
          item = self[i];
          if (Opal.hash_get(hash, item) === undefined) {
            Opal.hash_put(hash, item, item);
          }
        }
      }
      else {
        for (i = 0, length = self.length; i < length; i++) {
          item = self[i];
          key = Opal.yield1(block, item);
          if (Opal.hash_get(hash, key) === undefined) {
            Opal.hash_put(hash, key, item);
          }
        }
      }

      return toArraySubclass((hash).$values(), self.$class());
    ;
    }, TMP_102.$$arity = 0);

    Opal.defn(self, '$uniq!', TMP_103 = function() {
      var self = this, $iter = TMP_103.$$p, block = $iter || nil;

      TMP_103.$$p = null;
      
      var original_length = self.length, hash = $hash2([], {}), i, length, item, key;

      for (i = 0, length = original_length; i < length; i++) {
        item = self[i];
        key = (block === nil ? item : Opal.yield1(block, item));

        if (Opal.hash_get(hash, key) === undefined) {
          Opal.hash_put(hash, key, item);
          continue;
        }

        self.splice(i, 1);
        length--;
        i--;
      }

      return self.length === original_length ? nil : self;
    ;
    }, TMP_103.$$arity = 0);

    Opal.defn(self, '$unshift', TMP_104 = function $$unshift($a_rest) {
      var self = this, objects;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      objects = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        objects[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      for (var i = objects.length - 1; i >= 0; i--) {
        self.unshift(objects[i]);
      }
    
      return self;
    }, TMP_104.$$arity = -1);

    Opal.defn(self, '$values_at', TMP_107 = function $$values_at($a_rest) {
      var $b, $c, TMP_105, self = this, args, out = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      out = [];
      ($b = ($c = args).$each, $b.$$p = (TMP_105 = function(elem){var self = TMP_105.$$s || this, $a, $d, TMP_106, finish = nil, start = nil, i = nil;
if (elem == null) elem = nil;
      if ((($a = elem['$kind_of?']($scope.get('Range'))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          finish = $scope.get('Opal').$coerce_to(elem.$last(), $scope.get('Integer'), "to_int");
          start = $scope.get('Opal').$coerce_to(elem.$first(), $scope.get('Integer'), "to_int");
          
          if (start < 0) {
            start = start + self.length;
            return nil;;
          }
        
          
          if (finish < 0) {
            finish = finish + self.length;
          }
          if (elem['$exclude_end?']()) {
            finish--;
          }
          if (finish < start) {
            return nil;;
          }
        
          return ($a = ($d = start).$upto, $a.$$p = (TMP_106 = function(i){var self = TMP_106.$$s || this;
if (i == null) i = nil;
          return out['$<<'](self.$at(i))}, TMP_106.$$s = self, TMP_106.$$arity = 1, TMP_106), $a).call($d, finish);
          } else {
          i = $scope.get('Opal').$coerce_to(elem, $scope.get('Integer'), "to_int");
          return out['$<<'](self.$at(i));
        }}, TMP_105.$$s = self, TMP_105.$$arity = 1, TMP_105), $b).call($c);
      return out;
    }, TMP_107.$$arity = -1);

    Opal.defn(self, '$zip', TMP_108 = function $$zip($a_rest) {
      var $b, self = this, others, $iter = TMP_108.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      others = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        others[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_108.$$p = null;
      
      var result = [], size = self.length, part, o, i, j, jj;

      for (j = 0, jj = others.length; j < jj; j++) {
        o = others[j];
        if (o.$$is_array) {
          continue;
        }
        if (o.$$is_enumerator) {
          if (o.$size() === Infinity) {
            others[j] = o.$take(size);
          } else {
            others[j] = o.$to_a();
          }
          continue;
        }
        others[j] = (((($b = $scope.get('Opal')['$coerce_to?'](o, $scope.get('Array'), "to_ary")) !== false && $b !== nil && $b != null) ? $b : $scope.get('Opal')['$coerce_to!'](o, $scope.get('Enumerator'), "each"))).$to_a();
      }

      for (i = 0; i < size; i++) {
        part = [self[i]];

        for (j = 0, jj = others.length; j < jj; j++) {
          o = others[j][i];

          if (o == null) {
            o = nil;
          }

          part[j + 1] = o;
        }

        result[i] = part;
      }

      if (block !== nil) {
        for (i = 0; i < size; i++) {
          block(result[i]);
        }

        return nil;
      }

      return result;
    
    }, TMP_108.$$arity = -1);

    Opal.defs(self, '$inherited', TMP_109 = function $$inherited(klass) {
      var self = this;

      
      klass.$$proto.$to_a = function() {
        return this.slice(0, this.length);
      }
    
    }, TMP_109.$$arity = 1);

    Opal.defn(self, '$instance_variables', TMP_111 = function $$instance_variables() {
      var $a, $b, TMP_110, $c, $d, self = this, $iter = TMP_111.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_111.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      return ($a = ($b = ($c = ($d = self, Opal.find_super_dispatcher(self, 'instance_variables', TMP_111, false)), $c.$$p = $iter, $c).apply($d, $zuper)).$reject, $a.$$p = (TMP_110 = function(ivar){var self = TMP_110.$$s || this, $c;
if (ivar == null) ivar = nil;
      return ((($c = /^@\d+$/.test(ivar)) !== false && $c !== nil && $c != null) ? $c : ivar['$==']("@length"))}, TMP_110.$$s = self, TMP_110.$$arity = 1, TMP_110), $a).call($b);
    }, TMP_111.$$arity = 0);

    return $scope.get('Opal').$pristine(self, "allocate", "copy_instance_variables", "initialize_dup");
  })($scope.base, Array);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/hash"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$coerce_to?', '$[]', '$merge!', '$allocate', '$raise', '$==', '$coerce_to!', '$lambda?', '$abs', '$arity', '$call', '$enum_for', '$size', '$inspect', '$flatten', '$eql?', '$default', '$to_proc', '$dup', '$===', '$default_proc', '$default_proc=', '$default=', '$alias_method']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_18, TMP_20, TMP_22, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_36, TMP_37, TMP_38, TMP_39, TMP_40, TMP_41, TMP_42, TMP_44, TMP_46, TMP_47, TMP_49, TMP_51, TMP_52, TMP_53, TMP_54, TMP_55;

    self.$include($scope.get('Enumerable'));

    def.$$is_hash = true;

    Opal.defs(self, '$[]', TMP_1 = function($a_rest) {
      var self = this, argv;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      argv = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        argv[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var hash, argc = argv.length, i;

      if (argc === 1) {
        hash = $scope.get('Opal')['$coerce_to?'](argv['$[]'](0), $scope.get('Hash'), "to_hash");
        if (hash !== nil) {
          return self.$allocate()['$merge!'](hash);
        }

        argv = $scope.get('Opal')['$coerce_to?'](argv['$[]'](0), $scope.get('Array'), "to_ary");
        if (argv === nil) {
          self.$raise($scope.get('ArgumentError'), "odd number of arguments for Hash")
        }

        argc = argv.length;
        hash = self.$allocate();

        for (i = 0; i < argc; i++) {
          if (!argv[i].$$is_array) continue;
          switch(argv[i].length) {
          case 1:
            hash.$store(argv[i][0], nil);
            break;
          case 2:
            hash.$store(argv[i][0], argv[i][1]);
            break;
          default:
            self.$raise($scope.get('ArgumentError'), "invalid number of elements (" + (argv[i].length) + " for 1..2)")
          }
        }

        return hash;
      }

      if (argc % 2 !== 0) {
        self.$raise($scope.get('ArgumentError'), "odd number of arguments for Hash")
      }

      hash = self.$allocate();

      for (i = 0; i < argc; i += 2) {
        hash.$store(argv[i], argv[i + 1]);
      }

      return hash;
    ;
    }, TMP_1.$$arity = -1);

    Opal.defs(self, '$allocate', TMP_2 = function $$allocate() {
      var self = this;

      
      var hash = new self.$$alloc();

      Opal.hash_init(hash);

      hash.$$none = nil;
      hash.$$proc = nil;

      return hash;
    
    }, TMP_2.$$arity = 0);

    Opal.defs(self, '$try_convert', TMP_3 = function $$try_convert(obj) {
      var self = this;

      return $scope.get('Opal')['$coerce_to?'](obj, $scope.get('Hash'), "to_hash");
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$initialize', TMP_4 = function $$initialize(defaults) {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      
      if (defaults !== undefined && block !== nil) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (1 for 0)")
      }
      self.$$none = (defaults === undefined ? nil : defaults);
      self.$$proc = block;
    ;
      return self;
    }, TMP_4.$$arity = -1);

    Opal.defn(self, '$==', TMP_5 = function(other) {
      var self = this;

      
      if (self === other) {
        return true;
      }

      if (!other.$$is_hash) {
        return false;
      }

      if (self.$$keys.length !== other.$$keys.length) {
        return false;
      }

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, other_value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
          other_value = other.$$smap[key];
        } else {
          value = key.value;
          other_value = Opal.hash_get(other, key.key);
        }

        if (other_value === undefined || !value['$eql?'](other_value)) {
          return false;
        }
      }

      return true;
    
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$[]', TMP_6 = function(key) {
      var self = this;

      
      var value = Opal.hash_get(self, key);

      if (value !== undefined) {
        return value;
      }

      return self.$default(key);
    
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$[]=', TMP_7 = function(key, value) {
      var self = this;

      
      Opal.hash_put(self, key, value);
      return value;
    
    }, TMP_7.$$arity = 2);

    Opal.defn(self, '$assoc', TMP_8 = function $$assoc(object) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          if ((key)['$=='](object)) {
            return [key, self.$$smap[key]];
          }
        } else {
          if ((key.key)['$=='](object)) {
            return [key.key, key.value];
          }
        }
      }

      return nil;
    
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$clear', TMP_9 = function $$clear() {
      var self = this;

      
      Opal.hash_init(self);
      return self;
    
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$clone', TMP_10 = function $$clone() {
      var self = this;

      
      var hash = new self.$$class.$$alloc();

      Opal.hash_init(hash);
      Opal.hash_clone(self, hash);

      return hash;
    
    }, TMP_10.$$arity = 0);

    Opal.defn(self, '$default', TMP_11 = function(key) {
      var self = this;

      
      if (key !== undefined && self.$$proc !== nil && self.$$proc !== undefined) {
        return self.$$proc.$call(self, key);
      }
      if (self.$$none === undefined) {
        return nil;
      }
      return self.$$none;
    
    }, TMP_11.$$arity = -1);

    Opal.defn(self, '$default=', TMP_12 = function(object) {
      var self = this;

      
      self.$$proc = nil;
      self.$$none = object;

      return object;
    
    }, TMP_12.$$arity = 1);

    Opal.defn(self, '$default_proc', TMP_13 = function $$default_proc() {
      var self = this;

      
      if (self.$$proc !== undefined) {
        return self.$$proc;
      }
      return nil;
    
    }, TMP_13.$$arity = 0);

    Opal.defn(self, '$default_proc=', TMP_14 = function(proc) {
      var self = this;

      
      if (proc !== nil) {
        proc = $scope.get('Opal')['$coerce_to!'](proc, $scope.get('Proc'), "to_proc");

        if (proc['$lambda?']() && proc.$arity().$abs() !== 2) {
          self.$raise($scope.get('TypeError'), "default_proc takes two arguments");
        }
      }

      self.$$none = nil;
      self.$$proc = proc;

      return proc;
    ;
    }, TMP_14.$$arity = 1);

    Opal.defn(self, '$delete', TMP_15 = function(key) {
      var self = this, $iter = TMP_15.$$p, block = $iter || nil;

      TMP_15.$$p = null;
      
      var value = Opal.hash_delete(self, key);

      if (value !== undefined) {
        return value;
      }

      if (block !== nil) {
        return block.$call(key);
      }

      return nil;
    
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$delete_if', TMP_16 = function $$delete_if() {
      var $a, $b, TMP_17, self = this, $iter = TMP_16.$$p, block = $iter || nil;

      TMP_16.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_17 = function(){var self = TMP_17.$$s || this;

        return self.$size()}, TMP_17.$$s = self, TMP_17.$$arity = 0, TMP_17), $a).call($b, "delete_if")
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj !== false && obj !== nil) {
          if (Opal.hash_delete(self, key) !== undefined) {
            length--;
            i--;
          }
        }
      }

      return self;
    
    }, TMP_16.$$arity = 0);

    Opal.alias(self, 'dup', 'clone');

    Opal.defn(self, '$each', TMP_18 = function $$each() {
      var $a, $b, TMP_19, self = this, $iter = TMP_18.$$p, block = $iter || nil;

      TMP_18.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_19 = function(){var self = TMP_19.$$s || this;

        return self.$size()}, TMP_19.$$s = self, TMP_19.$$arity = 0, TMP_19), $a).call($b, "each")
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        Opal.yield1(block, [key, value]);
      }

      return self;
    
    }, TMP_18.$$arity = 0);

    Opal.defn(self, '$each_key', TMP_20 = function $$each_key() {
      var $a, $b, TMP_21, self = this, $iter = TMP_20.$$p, block = $iter || nil;

      TMP_20.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_21 = function(){var self = TMP_21.$$s || this;

        return self.$size()}, TMP_21.$$s = self, TMP_21.$$arity = 0, TMP_21), $a).call($b, "each_key")
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        block(key.$$is_string ? key : key.key);
      }

      return self;
    
    }, TMP_20.$$arity = 0);

    Opal.alias(self, 'each_pair', 'each');

    Opal.defn(self, '$each_value', TMP_22 = function $$each_value() {
      var $a, $b, TMP_23, self = this, $iter = TMP_22.$$p, block = $iter || nil;

      TMP_22.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_23 = function(){var self = TMP_23.$$s || this;

        return self.$size()}, TMP_23.$$s = self, TMP_23.$$arity = 0, TMP_23), $a).call($b, "each_value")
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        block(key.$$is_string ? self.$$smap[key] : key.value);
      }

      return self;
    
    }, TMP_22.$$arity = 0);

    Opal.defn(self, '$empty?', TMP_24 = function() {
      var self = this;

      return self.$$keys.length === 0;
    }, TMP_24.$$arity = 0);

    Opal.alias(self, 'eql?', '==');

    Opal.defn(self, '$fetch', TMP_25 = function $$fetch(key, defaults) {
      var self = this, $iter = TMP_25.$$p, block = $iter || nil;

      TMP_25.$$p = null;
      
      var value = Opal.hash_get(self, key);

      if (value !== undefined) {
        return value;
      }

      if (block !== nil) {
        return block(key);
      }

      if (defaults !== undefined) {
        return defaults;
      }
    
      return self.$raise($scope.get('KeyError'), "key not found: " + (key.$inspect()));
    }, TMP_25.$$arity = -2);

    Opal.defn(self, '$flatten', TMP_26 = function $$flatten(level) {
      var self = this;

      if (level == null) {
        level = 1;
      }
      level = $scope.get('Opal')['$coerce_to!'](level, $scope.get('Integer'), "to_int");
      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        result.push(key);

        if (value.$$is_array) {
          if (level === 1) {
            result.push(value);
            continue;
          }

          result = result.concat((value).$flatten(level - 2));
          continue;
        }

        result.push(value);
      }

      return result;
    
    }, TMP_26.$$arity = -1);

    Opal.defn(self, '$has_key?', TMP_27 = function(key) {
      var self = this;

      return Opal.hash_get(self, key) !== undefined;
    }, TMP_27.$$arity = 1);

    Opal.defn(self, '$has_value?', TMP_28 = function(value) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (((key.$$is_string ? self.$$smap[key] : key.value))['$=='](value)) {
          return true;
        }
      }

      return false;
    
    }, TMP_28.$$arity = 1);

    Opal.defn(self, '$hash', TMP_29 = function $$hash() {
      var self = this;

      
      var top = (Opal.hash_ids === undefined),
          hash_id = self.$object_id(),
          result = ['Hash'],
          key, item;

      try {
        if (top) {
          Opal.hash_ids = {};
        }

        if (Opal.hash_ids.hasOwnProperty(hash_id)) {
          return 'self';
        }

        for (key in Opal.hash_ids) {
          if (Opal.hash_ids.hasOwnProperty(key)) {
            item = Opal.hash_ids[key];
            if (self['$eql?'](item)) {
              return 'self';
            }
          }
        }

        Opal.hash_ids[hash_id] = self;

        for (var i = 0, keys = self.$$keys, length = keys.length; i < length; i++) {
          key = keys[i];

          if (key.$$is_string) {
            result.push([key, self.$$smap[key].$hash()]);
          } else {
            result.push([key.key_hash, key.value.$hash()]);
          }
        }

        return result.sort().join();

      } finally {
        if (top) {
          delete Opal.hash_ids;
        }
      }
    
    }, TMP_29.$$arity = 0);

    Opal.alias(self, 'include?', 'has_key?');

    Opal.defn(self, '$index', TMP_30 = function $$index(object) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        if ((value)['$=='](object)) {
          return key;
        }
      }

      return nil;
    
    }, TMP_30.$$arity = 1);

    Opal.defn(self, '$indexes', TMP_31 = function $$indexes($a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      var result = [];

      for (var i = 0, length = args.length, key, value; i < length; i++) {
        key = args[i];
        value = Opal.hash_get(self, key);

        if (value === undefined) {
          result.push(self.$default());
          continue;
        }

        result.push(value);
      }

      return result;
    
    }, TMP_31.$$arity = -1);

    Opal.alias(self, 'indices', 'indexes');

    var inspect_ids;

    Opal.defn(self, '$inspect', TMP_32 = function $$inspect() {
      var self = this;

      
      var top = (inspect_ids === undefined),
          hash_id = self.$object_id(),
          result = [];

      try {
        if (top) {
          inspect_ids = {};
        }

        if (inspect_ids.hasOwnProperty(hash_id)) {
          return '{...}';
        }

        inspect_ids[hash_id] = true;

        for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
          key = keys[i];

          if (key.$$is_string) {
            value = self.$$smap[key];
          } else {
            value = key.value;
            key = key.key;
          }

          result.push(key.$inspect() + '=>' + value.$inspect());
        }

        return '{' + result.join(', ') + '}';

      } finally {
        if (top) {
          inspect_ids = undefined;
        }
      }
    
    }, TMP_32.$$arity = 0);

    Opal.defn(self, '$invert', TMP_33 = function $$invert() {
      var self = this;

      
      var hash = Opal.hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        Opal.hash_put(hash, value, key);
      }

      return hash;
    
    }, TMP_33.$$arity = 0);

    Opal.defn(self, '$keep_if', TMP_34 = function $$keep_if() {
      var $a, $b, TMP_35, self = this, $iter = TMP_34.$$p, block = $iter || nil;

      TMP_34.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_35 = function(){var self = TMP_35.$$s || this;

        return self.$size()}, TMP_35.$$s = self, TMP_35.$$arity = 0, TMP_35), $a).call($b, "keep_if")
      };
      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj === false || obj === nil) {
          if (Opal.hash_delete(self, key) !== undefined) {
            length--;
            i--;
          }
        }
      }

      return self;
    
    }, TMP_34.$$arity = 0);

    Opal.alias(self, 'key', 'index');

    Opal.alias(self, 'key?', 'has_key?');

    Opal.defn(self, '$keys', TMP_36 = function $$keys() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          result.push(key);
        } else {
          result.push(key.key);
        }
      }

      return result;
    
    }, TMP_36.$$arity = 0);

    Opal.defn(self, '$length', TMP_37 = function $$length() {
      var self = this;

      return self.$$keys.length;
    }, TMP_37.$$arity = 0);

    Opal.alias(self, 'member?', 'has_key?');

    Opal.defn(self, '$merge', TMP_38 = function $$merge(other) {
      var $a, $b, self = this, $iter = TMP_38.$$p, block = $iter || nil;

      TMP_38.$$p = null;
      return ($a = ($b = self.$dup())['$merge!'], $a.$$p = block.$to_proc(), $a).call($b, other);
    }, TMP_38.$$arity = 1);

    Opal.defn(self, '$merge!', TMP_39 = function(other) {
      var self = this, $iter = TMP_39.$$p, block = $iter || nil;

      TMP_39.$$p = null;
      
      if (!$scope.get('Hash')['$==='](other)) {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Hash'), "to_hash");
      }

      var i, other_keys = other.$$keys, length = other_keys.length, key, value, other_value;

      if (block === nil) {
        for (i = 0; i < length; i++) {
          key = other_keys[i];

          if (key.$$is_string) {
            other_value = other.$$smap[key];
          } else {
            other_value = key.value;
            key = key.key;
          }

          Opal.hash_put(self, key, other_value);
        }

        return self;
      }

      for (i = 0; i < length; i++) {
        key = other_keys[i];

        if (key.$$is_string) {
          other_value = other.$$smap[key];
        } else {
          other_value = key.value;
          key = key.key;
        }

        value = Opal.hash_get(self, key);

        if (value === undefined) {
          Opal.hash_put(self, key, other_value);
          continue;
        }

        Opal.hash_put(self, key, block(key, value, other_value));
      }

      return self;
    ;
    }, TMP_39.$$arity = 1);

    Opal.defn(self, '$rassoc', TMP_40 = function $$rassoc(object) {
      var self = this;

      
      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        if ((value)['$=='](object)) {
          return [key, value];
        }
      }

      return nil;
    
    }, TMP_40.$$arity = 1);

    Opal.defn(self, '$rehash', TMP_41 = function $$rehash() {
      var self = this;

      
      Opal.hash_rehash(self);
      return self;
    
    }, TMP_41.$$arity = 0);

    Opal.defn(self, '$reject', TMP_42 = function $$reject() {
      var $a, $b, TMP_43, self = this, $iter = TMP_42.$$p, block = $iter || nil;

      TMP_42.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_43 = function(){var self = TMP_43.$$s || this;

        return self.$size()}, TMP_43.$$s = self, TMP_43.$$arity = 0, TMP_43), $a).call($b, "reject")
      };
      
      var hash = Opal.hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj === false || obj === nil) {
          Opal.hash_put(hash, key, value);
        }
      }

      return hash;
    
    }, TMP_42.$$arity = 0);

    Opal.defn(self, '$reject!', TMP_44 = function() {
      var $a, $b, TMP_45, self = this, $iter = TMP_44.$$p, block = $iter || nil;

      TMP_44.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_45 = function(){var self = TMP_45.$$s || this;

        return self.$size()}, TMP_45.$$s = self, TMP_45.$$arity = 0, TMP_45), $a).call($b, "reject!")
      };
      
      var changes_were_made = false;

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj !== false && obj !== nil) {
          if (Opal.hash_delete(self, key) !== undefined) {
            changes_were_made = true;
            length--;
            i--;
          }
        }
      }

      return changes_were_made ? self : nil;
    
    }, TMP_44.$$arity = 0);

    Opal.defn(self, '$replace', TMP_46 = function $$replace(other) {
      var $a, $b, self = this;

      other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Hash'), "to_hash");
      
      Opal.hash_init(self);

      for (var i = 0, other_keys = other.$$keys, length = other_keys.length, key, value, other_value; i < length; i++) {
        key = other_keys[i];

        if (key.$$is_string) {
          other_value = other.$$smap[key];
        } else {
          other_value = key.value;
          key = key.key;
        }

        Opal.hash_put(self, key, other_value);
      }
    
      if ((($a = other.$default_proc()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        (($a = [other.$default_proc()]), $b = self, $b['$default_proc='].apply($b, $a), $a[$a.length-1])
        } else {
        (($a = [other.$default()]), $b = self, $b['$default='].apply($b, $a), $a[$a.length-1])
      };
      return self;
    }, TMP_46.$$arity = 1);

    Opal.defn(self, '$select', TMP_47 = function $$select() {
      var $a, $b, TMP_48, self = this, $iter = TMP_47.$$p, block = $iter || nil;

      TMP_47.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_48 = function(){var self = TMP_48.$$s || this;

        return self.$size()}, TMP_48.$$s = self, TMP_48.$$arity = 0, TMP_48), $a).call($b, "select")
      };
      
      var hash = Opal.hash();

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj !== false && obj !== nil) {
          Opal.hash_put(hash, key, value);
        }
      }

      return hash;
    
    }, TMP_47.$$arity = 0);

    Opal.defn(self, '$select!', TMP_49 = function() {
      var $a, $b, TMP_50, self = this, $iter = TMP_49.$$p, block = $iter || nil;

      TMP_49.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_50 = function(){var self = TMP_50.$$s || this;

        return self.$size()}, TMP_50.$$s = self, TMP_50.$$arity = 0, TMP_50), $a).call($b, "select!")
      };
      
      var result = nil;

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value, obj; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        obj = block(key, value);

        if (obj === false || obj === nil) {
          if (Opal.hash_delete(self, key) !== undefined) {
            length--;
            i--;
          }
          result = self;
        }
      }

      return result;
    
    }, TMP_49.$$arity = 0);

    Opal.defn(self, '$shift', TMP_51 = function $$shift() {
      var self = this;

      
      var keys = self.$$keys,
          key;

      if (keys.length > 0) {
        key = keys[0];

        key = key.$$is_string ? key : key.key;

        return [key, Opal.hash_delete(self, key)];
      }

      return self.$default(nil);
    
    }, TMP_51.$$arity = 0);

    Opal.alias(self, 'size', 'length');

    self.$alias_method("store", "[]=");

    Opal.defn(self, '$to_a', TMP_52 = function $$to_a() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key, value; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          value = self.$$smap[key];
        } else {
          value = key.value;
          key = key.key;
        }

        result.push([key, value]);
      }

      return result;
    
    }, TMP_52.$$arity = 0);

    Opal.defn(self, '$to_h', TMP_53 = function $$to_h() {
      var self = this;

      
      if (self.$$class === Opal.Hash) {
        return self;
      }

      var hash = new Opal.Hash.$$alloc();

      Opal.hash_init(hash);
      Opal.hash_clone(self, hash);

      return hash;
    
    }, TMP_53.$$arity = 0);

    Opal.defn(self, '$to_hash', TMP_54 = function $$to_hash() {
      var self = this;

      return self;
    }, TMP_54.$$arity = 0);

    Opal.alias(self, 'to_s', 'inspect');

    Opal.alias(self, 'update', 'merge!');

    Opal.alias(self, 'value?', 'has_value?');

    Opal.alias(self, 'values_at', 'indexes');

    return (Opal.defn(self, '$values', TMP_55 = function $$values() {
      var self = this;

      
      var result = [];

      for (var i = 0, keys = self.$$keys, length = keys.length, key; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          result.push(self.$$smap[key]);
        } else {
          result.push(key.value);
        }
      }

      return result;
    
    }, TMP_55.$$arity = 0), nil) && 'values';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/number"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  function $rb_ge(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs >= rhs : lhs['$>='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$bridge', '$raise', '$class', '$Float', '$respond_to?', '$coerce_to!', '$__coerced__', '$===', '$!', '$>', '$**', '$new', '$<', '$to_f', '$==', '$nan?', '$infinite?', '$enum_for', '$+', '$-', '$gcd', '$lcm', '$/', '$frexp', '$to_i', '$ldexp', '$rationalize', '$*', '$<<', '$to_r', '$-@', '$size', '$<=', '$>=']);
  self.$require("corelib/numeric");
  (function($base, $super) {
    function $Number(){};
    var self = $Number = $klass($base, $super, 'Number', $Number);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_33, TMP_34, TMP_35, TMP_36, TMP_37, TMP_38, TMP_39, TMP_40, TMP_41, TMP_42, TMP_43, TMP_44, TMP_45, TMP_46, TMP_47, TMP_48, TMP_49, TMP_50, TMP_51, TMP_52, TMP_54, TMP_55, TMP_56, TMP_57, TMP_58, TMP_59, TMP_61, TMP_62, TMP_63, TMP_64, TMP_65, TMP_66, TMP_67;

    $scope.get('Opal').$bridge(self, Number);

    Number.prototype.$$is_number = true;

    Opal.defn(self, '$coerce', TMP_1 = function $$coerce(other) {
      var self = this;

      
      if (other === nil) {
        self.$raise($scope.get('TypeError'), "can't convert " + (other.$class()) + " into Float");
      }
      else if (other.$$is_string) {
        return [self.$Float(other), self];
      }
      else if (other['$respond_to?']("to_f")) {
        return [$scope.get('Opal')['$coerce_to!'](other, $scope.get('Float'), "to_f"), self];
      }
      else if (other.$$is_number) {
        return [other, self];
      }
      else {
        self.$raise($scope.get('TypeError'), "can't convert " + (other.$class()) + " into Float");
      }
    ;
    }, TMP_1.$$arity = 1);

    Opal.defn(self, '$__id__', TMP_2 = function $$__id__() {
      var self = this;

      return (self * 2) + 1;
    }, TMP_2.$$arity = 0);

    Opal.alias(self, 'object_id', '__id__');

    Opal.defn(self, '$+', TMP_3 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self + other;
      }
      else {
        return self.$__coerced__("+", other);
      }
    
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$-', TMP_4 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self - other;
      }
      else {
        return self.$__coerced__("-", other);
      }
    
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$*', TMP_5 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self * other;
      }
      else {
        return self.$__coerced__("*", other);
      }
    
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$/', TMP_6 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self / other;
      }
      else {
        return self.$__coerced__("/", other);
      }
    
    }, TMP_6.$$arity = 1);

    Opal.alias(self, 'fdiv', '/');

    Opal.defn(self, '$%', TMP_7 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        if (other == -Infinity) {
          return other;
        }
        else if (other == 0) {
          self.$raise($scope.get('ZeroDivisionError'), "divided by 0");
        }
        else if (other < 0 || self < 0) {
          return (self % other + other) % other;
        }
        else {
          return self % other;
        }
      }
      else {
        return self.$__coerced__("%", other);
      }
    
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$&', TMP_8 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self & other;
      }
      else {
        return self.$__coerced__("&", other);
      }
    
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$|', TMP_9 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self | other;
      }
      else {
        return self.$__coerced__("|", other);
      }
    
    }, TMP_9.$$arity = 1);

    Opal.defn(self, '$^', TMP_10 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self ^ other;
      }
      else {
        return self.$__coerced__("^", other);
      }
    
    }, TMP_10.$$arity = 1);

    Opal.defn(self, '$<', TMP_11 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self < other;
      }
      else {
        return self.$__coerced__("<", other);
      }
    
    }, TMP_11.$$arity = 1);

    Opal.defn(self, '$<=', TMP_12 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self <= other;
      }
      else {
        return self.$__coerced__("<=", other);
      }
    
    }, TMP_12.$$arity = 1);

    Opal.defn(self, '$>', TMP_13 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self > other;
      }
      else {
        return self.$__coerced__(">", other);
      }
    
    }, TMP_13.$$arity = 1);

    Opal.defn(self, '$>=', TMP_14 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self >= other;
      }
      else {
        return self.$__coerced__(">=", other);
      }
    
    }, TMP_14.$$arity = 1);

    
    var spaceship_operator = function(self, other) {
      if (other.$$is_number) {
        if (isNaN(self) || isNaN(other)) {
          return nil;
        }

        if (self > other) {
          return 1;
        } else if (self < other) {
          return -1;
        } else {
          return 0;
        }
      }
      else {
        return self.$__coerced__("<=>", other);
      }
    }
  

    Opal.defn(self, '$<=>', TMP_15 = function(other) {
      var self = this;

      try {
        
      return spaceship_operator(self, other);
    
      } catch ($err) {
        if (Opal.rescue($err, [$scope.get('ArgumentError')])) {
          try {
            return nil
          } finally { Opal.pop_exception() }
        } else { throw $err; }
      };
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$<<', TMP_16 = function(count) {
      var self = this;

      count = $scope.get('Opal')['$coerce_to!'](count, $scope.get('Integer'), "to_int");
      return count > 0 ? self << count : self >> -count;
    }, TMP_16.$$arity = 1);

    Opal.defn(self, '$>>', TMP_17 = function(count) {
      var self = this;

      count = $scope.get('Opal')['$coerce_to!'](count, $scope.get('Integer'), "to_int");
      return count > 0 ? self >> count : self << -count;
    }, TMP_17.$$arity = 1);

    Opal.defn(self, '$[]', TMP_18 = function(bit) {
      var self = this;

      bit = $scope.get('Opal')['$coerce_to!'](bit, $scope.get('Integer'), "to_int");
      
      if (bit < 0) {
        return 0;
      }
      if (bit >= 32) {
        return self < 0 ? 1 : 0;
      }
      return (self >> bit) & 1;
    ;
    }, TMP_18.$$arity = 1);

    Opal.defn(self, '$+@', TMP_19 = function() {
      var self = this;

      return +self;
    }, TMP_19.$$arity = 0);

    Opal.defn(self, '$-@', TMP_20 = function() {
      var self = this;

      return -self;
    }, TMP_20.$$arity = 0);

    Opal.defn(self, '$~', TMP_21 = function() {
      var self = this;

      return ~self;
    }, TMP_21.$$arity = 0);

    Opal.defn(self, '$**', TMP_22 = function(other) {
      var $a, $b, $c, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = ((($b = ($scope.get('Integer')['$==='](self))['$!']()) !== false && $b !== nil && $b != null) ? $b : $rb_gt(other, 0))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return Math.pow(self, other);
          } else {
          return $scope.get('Rational').$new(self, 1)['$**'](other)
        }
      } else if ((($a = (($b = $rb_lt(self, 0)) ? (((($c = $scope.get('Float')['$==='](other)) !== false && $c !== nil && $c != null) ? $c : $scope.get('Rational')['$==='](other))) : $rb_lt(self, 0))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('Complex').$new(self, 0)['$**'](other.$to_f())
      } else if ((($a = other.$$is_number != null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return Math.pow(self, other);
        } else {
        return self.$__coerced__("**", other)
      };
    }, TMP_22.$$arity = 1);

    Opal.defn(self, '$==', TMP_23 = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self == Number(other);
      }
      else if (other['$respond_to?']("==")) {
        return other['$=='](self);
      }
      else {
        return false;
      }
    ;
    }, TMP_23.$$arity = 1);

    Opal.defn(self, '$abs', TMP_24 = function $$abs() {
      var self = this;

      return Math.abs(self);
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$abs2', TMP_25 = function $$abs2() {
      var self = this;

      return Math.abs(self * self);
    }, TMP_25.$$arity = 0);

    Opal.defn(self, '$angle', TMP_26 = function $$angle() {
      var $a, self = this;

      if ((($a = self['$nan?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      if (self == 0) {
        if (1 / self > 0) {
          return 0;
        }
        else {
          return Math.PI;
        }
      }
      else if (self < 0) {
        return Math.PI;
      }
      else {
        return 0;
      }
    
    }, TMP_26.$$arity = 0);

    Opal.alias(self, 'arg', 'angle');

    Opal.alias(self, 'phase', 'angle');

    Opal.defn(self, '$bit_length', TMP_27 = function $$bit_length() {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](self)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NoMethodError').$new("undefined method `bit_length` for " + (self) + ":Float", "bit_length"))
      };
      
      if (self === 0 || self === -1) {
        return 0;
      }

      var result = 0,
          value  = self < 0 ? ~self : self;

      while (value != 0) {
        result   += 1;
        value  >>>= 1;
      }

      return result;
    
    }, TMP_27.$$arity = 0);

    Opal.defn(self, '$ceil', TMP_28 = function $$ceil() {
      var self = this;

      return Math.ceil(self);
    }, TMP_28.$$arity = 0);

    Opal.defn(self, '$chr', TMP_29 = function $$chr(encoding) {
      var self = this;

      return String.fromCharCode(self);
    }, TMP_29.$$arity = -1);

    Opal.defn(self, '$denominator', TMP_30 = function $$denominator() {
      var $a, $b, self = this, $iter = TMP_30.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_30.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = ((($b = self['$nan?']()) !== false && $b !== nil && $b != null) ? $b : self['$infinite?']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return 1
        } else {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'denominator', TMP_30, false)), $a.$$p = $iter, $a).apply($b, $zuper)
      };
    }, TMP_30.$$arity = 0);

    Opal.defn(self, '$downto', TMP_31 = function $$downto(stop) {
      var $a, $b, TMP_32, self = this, $iter = TMP_31.$$p, block = $iter || nil;

      TMP_31.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_32 = function(){var self = TMP_32.$$s || this, $c;

        if ((($c = $scope.get('Numeric')['$==='](stop)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            } else {
            self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
          };
          if ((($c = $rb_gt(stop, self)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return 0
            } else {
            return $rb_plus($rb_minus(self, stop), 1)
          };}, TMP_32.$$s = self, TMP_32.$$arity = 0, TMP_32), $a).call($b, "downto", stop)
      };
      
      if (!stop.$$is_number) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
      }
      for (var i = self; i >= stop; i--) {
        block(i);
      }
    ;
      return self;
    }, TMP_31.$$arity = 1);

    Opal.alias(self, 'eql?', '==');

    Opal.defn(self, '$equal?', TMP_33 = function(other) {
      var $a, self = this;

      return ((($a = self['$=='](other)) !== false && $a !== nil && $a != null) ? $a : isNaN(self) && isNaN(other));
    }, TMP_33.$$arity = 1);

    Opal.defn(self, '$even?', TMP_34 = function() {
      var self = this;

      return self % 2 === 0;
    }, TMP_34.$$arity = 0);

    Opal.defn(self, '$floor', TMP_35 = function $$floor() {
      var self = this;

      return Math.floor(self);
    }, TMP_35.$$arity = 0);

    Opal.defn(self, '$gcd', TMP_36 = function $$gcd(other) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an integer")
      };
      
      var min = Math.abs(self),
          max = Math.abs(other);

      while (min > 0) {
        var tmp = min;

        min = max % min;
        max = tmp;
      }

      return max;
    
    }, TMP_36.$$arity = 1);

    Opal.defn(self, '$gcdlcm', TMP_37 = function $$gcdlcm(other) {
      var self = this;

      return [self.$gcd(), self.$lcm()];
    }, TMP_37.$$arity = 1);

    Opal.defn(self, '$integer?', TMP_38 = function() {
      var self = this;

      return self % 1 === 0;
    }, TMP_38.$$arity = 0);

    Opal.defn(self, '$is_a?', TMP_39 = function(klass) {
      var $a, $b, self = this, $iter = TMP_39.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_39.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = (($b = klass['$==']($scope.get('Fixnum'))) ? $scope.get('Integer')['$==='](self) : klass['$==']($scope.get('Fixnum')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Integer'))) ? $scope.get('Integer')['$==='](self) : klass['$==']($scope.get('Integer')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Float'))) ? $scope.get('Float')['$==='](self) : klass['$==']($scope.get('Float')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      return ($a = ($b = self, Opal.find_super_dispatcher(self, 'is_a?', TMP_39, false)), $a.$$p = $iter, $a).apply($b, $zuper);
    }, TMP_39.$$arity = 1);

    Opal.alias(self, 'kind_of?', 'is_a?');

    Opal.defn(self, '$instance_of?', TMP_40 = function(klass) {
      var $a, $b, self = this, $iter = TMP_40.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_40.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = (($b = klass['$==']($scope.get('Fixnum'))) ? $scope.get('Integer')['$==='](self) : klass['$==']($scope.get('Fixnum')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Integer'))) ? $scope.get('Integer')['$==='](self) : klass['$==']($scope.get('Integer')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Float'))) ? $scope.get('Float')['$==='](self) : klass['$==']($scope.get('Float')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return true};
      return ($a = ($b = self, Opal.find_super_dispatcher(self, 'instance_of?', TMP_40, false)), $a.$$p = $iter, $a).apply($b, $zuper);
    }, TMP_40.$$arity = 1);

    Opal.defn(self, '$lcm', TMP_41 = function $$lcm(other) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an integer")
      };
      
      if (self == 0 || other == 0) {
        return 0;
      }
      else {
        return Math.abs(self * other / self.$gcd(other));
      }
    
    }, TMP_41.$$arity = 1);

    Opal.alias(self, 'magnitude', 'abs');

    Opal.alias(self, 'modulo', '%');

    Opal.defn(self, '$next', TMP_42 = function $$next() {
      var self = this;

      return self + 1;
    }, TMP_42.$$arity = 0);

    Opal.defn(self, '$nonzero?', TMP_43 = function() {
      var self = this;

      return self == 0 ? nil : self;
    }, TMP_43.$$arity = 0);

    Opal.defn(self, '$numerator', TMP_44 = function $$numerator() {
      var $a, $b, self = this, $iter = TMP_44.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_44.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = ((($b = self['$nan?']()) !== false && $b !== nil && $b != null) ? $b : self['$infinite?']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self
        } else {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'numerator', TMP_44, false)), $a.$$p = $iter, $a).apply($b, $zuper)
      };
    }, TMP_44.$$arity = 0);

    Opal.defn(self, '$odd?', TMP_45 = function() {
      var self = this;

      return self % 2 !== 0;
    }, TMP_45.$$arity = 0);

    Opal.defn(self, '$ord', TMP_46 = function $$ord() {
      var self = this;

      return self;
    }, TMP_46.$$arity = 0);

    Opal.defn(self, '$pred', TMP_47 = function $$pred() {
      var self = this;

      return self - 1;
    }, TMP_47.$$arity = 0);

    Opal.defn(self, '$quo', TMP_48 = function $$quo(other) {
      var $a, $b, self = this, $iter = TMP_48.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_48.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = $scope.get('Integer')['$==='](self)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'quo', TMP_48, false)), $a.$$p = $iter, $a).apply($b, $zuper)
        } else {
        return $rb_divide(self, other)
      };
    }, TMP_48.$$arity = 1);

    Opal.defn(self, '$rationalize', TMP_49 = function $$rationalize(eps) {
      var $a, $b, self = this, f = nil, n = nil;

      
      if (arguments.length > 1) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..1)");
      }
    ;
      if ((($a = $scope.get('Integer')['$==='](self)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('Rational').$new(self, 1)
      } else if ((($a = self['$infinite?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('FloatDomainError'), "Infinity")
      } else if ((($a = self['$nan?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('FloatDomainError'), "NaN")
      } else if ((($a = eps == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        $b = $scope.get('Math').$frexp(self), $a = Opal.to_ary($b), f = ($a[0] == null ? nil : $a[0]), n = ($a[1] == null ? nil : $a[1]), $b;
        f = $scope.get('Math').$ldexp(f, (($scope.get('Float')).$$scope.get('MANT_DIG'))).$to_i();
        n = $rb_minus(n, (($scope.get('Float')).$$scope.get('MANT_DIG')));
        return $scope.get('Rational').$new($rb_times(2, f), (1)['$<<'](($rb_minus(1, n)))).$rationalize($scope.get('Rational').$new(1, (1)['$<<'](($rb_minus(1, n)))));
        } else {
        return self.$to_r().$rationalize(eps)
      };
    }, TMP_49.$$arity = -1);

    Opal.defn(self, '$round', TMP_50 = function $$round(ndigits) {
      var $a, $b, self = this, _ = nil, exp = nil;

      if ((($a = $scope.get('Integer')['$==='](self)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = ndigits == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self};
        if ((($a = ($b = $scope.get('Float')['$==='](ndigits), $b !== false && $b !== nil && $b != null ?ndigits['$infinite?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('RangeError'), "Infinity")};
        ndigits = $scope.get('Opal')['$coerce_to!'](ndigits, $scope.get('Integer'), "to_int");
        if ((($a = $rb_lt(ndigits, (($scope.get('Integer')).$$scope.get('MIN')))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('RangeError'), "out of bounds")};
        if ((($a = ndigits >= 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self};
        ndigits = ndigits['$-@']();
        
        if (0.415241 * ndigits - 0.125 > self.$size()) {
          return 0;
        }

        var f = Math.pow(10, ndigits),
            x = Math.floor((Math.abs(x) + f / 2) / f) * f;

        return self < 0 ? -x : x;
      ;
        } else {
        if ((($a = ($b = self['$nan?'](), $b !== false && $b !== nil && $b != null ?ndigits == null : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('FloatDomainError'), "NaN")};
        ndigits = $scope.get('Opal')['$coerce_to!'](ndigits || 0, $scope.get('Integer'), "to_int");
        if ((($a = $rb_le(ndigits, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = self['$nan?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            self.$raise($scope.get('RangeError'), "NaN")
          } else if ((($a = self['$infinite?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            self.$raise($scope.get('FloatDomainError'), "Infinity")}
        } else if (ndigits['$=='](0)) {
          return Math.round(self)
        } else if ((($a = ((($b = self['$nan?']()) !== false && $b !== nil && $b != null) ? $b : self['$infinite?']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self};
        $b = $scope.get('Math').$frexp(self), $a = Opal.to_ary($b), _ = ($a[0] == null ? nil : $a[0]), exp = ($a[1] == null ? nil : $a[1]), $b;
        if ((($a = $rb_ge(ndigits, $rb_minus(($rb_plus((($scope.get('Float')).$$scope.get('DIG')), 2)), ((function() {if ((($b = $rb_gt(exp, 0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          return $rb_divide(exp, 4)
          } else {
          return $rb_minus($rb_divide(exp, 3), 1)
        }; return nil; })())))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self};
        if ((($a = $rb_lt(ndigits, ((function() {if ((($b = $rb_gt(exp, 0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          return $rb_plus($rb_divide(exp, 3), 1)
          } else {
          return $rb_divide(exp, 4)
        }; return nil; })())['$-@']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return 0};
        return Math.round(self * Math.pow(10, ndigits)) / Math.pow(10, ndigits);
      };
    }, TMP_50.$$arity = -1);

    Opal.defn(self, '$step', TMP_51 = function $$step(limit, step) {
      var $a, self = this, $iter = TMP_51.$$p, block = $iter || nil;

      if (step == null) {
        step = 1;
      }
      TMP_51.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return self.$enum_for("step", limit, step)
      };
      if ((($a = step == 0) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "step cannot be 0")};
      
      var value = self;

      if (limit === Infinity || limit === -Infinity) {
        block(value);
        return self;
      }

      if (step > 0) {
        while (value <= limit) {
          block(value);
          value += step;
        }
      }
      else {
        while (value >= limit) {
          block(value);
          value += step;
        }
      }
    
      return self;
    }, TMP_51.$$arity = -2);

    Opal.alias(self, 'succ', 'next');

    Opal.defn(self, '$times', TMP_52 = function $$times() {
      var $a, $b, TMP_53, self = this, $iter = TMP_52.$$p, block = $iter || nil;

      TMP_52.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_53 = function(){var self = TMP_53.$$s || this;

        return self}, TMP_53.$$s = self, TMP_53.$$arity = 0, TMP_53), $a).call($b, "times")
      };
      
      for (var i = 0; i < self; i++) {
        block(i);
      }
    
      return self;
    }, TMP_52.$$arity = 0);

    Opal.defn(self, '$to_f', TMP_54 = function $$to_f() {
      var self = this;

      return self;
    }, TMP_54.$$arity = 0);

    Opal.defn(self, '$to_i', TMP_55 = function $$to_i() {
      var self = this;

      return parseInt(self, 10);
    }, TMP_55.$$arity = 0);

    Opal.alias(self, 'to_int', 'to_i');

    Opal.defn(self, '$to_r', TMP_56 = function $$to_r() {
      var $a, $b, self = this, f = nil, e = nil;

      if ((($a = $scope.get('Integer')['$==='](self)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('Rational').$new(self, 1)
        } else {
        $b = $scope.get('Math').$frexp(self), $a = Opal.to_ary($b), f = ($a[0] == null ? nil : $a[0]), e = ($a[1] == null ? nil : $a[1]), $b;
        f = $scope.get('Math').$ldexp(f, (($scope.get('Float')).$$scope.get('MANT_DIG'))).$to_i();
        e = $rb_minus(e, (($scope.get('Float')).$$scope.get('MANT_DIG')));
        return ($rb_times(f, ((($scope.get('Float')).$$scope.get('RADIX'))['$**'](e)))).$to_r();
      };
    }, TMP_56.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_57 = function $$to_s(base) {
      var $a, $b, self = this;

      if (base == null) {
        base = 10;
      }
      if ((($a = ((($b = $rb_lt(base, 2)) !== false && $b !== nil && $b != null) ? $b : $rb_gt(base, 36))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "base must be between 2 and 36")};
      return self.toString(base);
    }, TMP_57.$$arity = -1);

    Opal.alias(self, 'truncate', 'to_i');

    Opal.alias(self, 'inspect', 'to_s');

    Opal.defn(self, '$divmod', TMP_58 = function $$divmod(other) {
      var $a, $b, self = this, $iter = TMP_58.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_58.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if ((($a = ((($b = self['$nan?']()) !== false && $b !== nil && $b != null) ? $b : other['$nan?']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('FloatDomainError'), "NaN")
      } else if ((($a = self['$infinite?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('FloatDomainError'), "Infinity")
        } else {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'divmod', TMP_58, false)), $a.$$p = $iter, $a).apply($b, $zuper)
      };
    }, TMP_58.$$arity = 1);

    Opal.defn(self, '$upto', TMP_59 = function $$upto(stop) {
      var $a, $b, TMP_60, self = this, $iter = TMP_59.$$p, block = $iter || nil;

      TMP_59.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_60 = function(){var self = TMP_60.$$s || this, $c;

        if ((($c = $scope.get('Numeric')['$==='](stop)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            } else {
            self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
          };
          if ((($c = $rb_lt(stop, self)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return 0
            } else {
            return $rb_plus($rb_minus(stop, self), 1)
          };}, TMP_60.$$s = self, TMP_60.$$arity = 0, TMP_60), $a).call($b, "upto", stop)
      };
      
      if (!stop.$$is_number) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (stop.$class()) + " failed")
      }
      for (var i = self; i <= stop; i++) {
        block(i);
      }
    ;
      return self;
    }, TMP_59.$$arity = 1);

    Opal.defn(self, '$zero?', TMP_61 = function() {
      var self = this;

      return self == 0;
    }, TMP_61.$$arity = 0);

    Opal.defn(self, '$size', TMP_62 = function $$size() {
      var self = this;

      return 4;
    }, TMP_62.$$arity = 0);

    Opal.defn(self, '$nan?', TMP_63 = function() {
      var self = this;

      return isNaN(self);
    }, TMP_63.$$arity = 0);

    Opal.defn(self, '$finite?', TMP_64 = function() {
      var self = this;

      return self != Infinity && self != -Infinity && !isNaN(self);
    }, TMP_64.$$arity = 0);

    Opal.defn(self, '$infinite?', TMP_65 = function() {
      var self = this;

      
      if (self == Infinity) {
        return +1;
      }
      else if (self == -Infinity) {
        return -1;
      }
      else {
        return nil;
      }
    
    }, TMP_65.$$arity = 0);

    Opal.defn(self, '$positive?', TMP_66 = function() {
      var self = this;

      return self == Infinity || 1 / self > 0;
    }, TMP_66.$$arity = 0);

    return (Opal.defn(self, '$negative?', TMP_67 = function() {
      var self = this;

      return self == -Infinity || 1 / self < 0;
    }, TMP_67.$$arity = 0), nil) && 'negative?';
  })($scope.base, $scope.get('Numeric'));
  Opal.cdecl($scope, 'Fixnum', $scope.get('Number'));
  (function($base, $super) {
    function $Integer(){};
    var self = $Integer = $klass($base, $super, 'Integer', $Integer);

    var def = self.$$proto, $scope = self.$$scope, TMP_68;

    Opal.defs(self, '$===', TMP_68 = function(other) {
      var self = this;

      
      if (!other.$$is_number) {
        return false;
      }

      return (other % 1) === 0;
    
    }, TMP_68.$$arity = 1);

    Opal.cdecl($scope, 'MAX', Math.pow(2, 30) - 1);

    return Opal.cdecl($scope, 'MIN', -Math.pow(2, 30));
  })($scope.base, $scope.get('Numeric'));
  return (function($base, $super) {
    function $Float(){};
    var self = $Float = $klass($base, $super, 'Float', $Float);

    var def = self.$$proto, $scope = self.$$scope, TMP_69, $a;

    Opal.defs(self, '$===', TMP_69 = function(other) {
      var self = this;

      return !!other.$$is_number;
    }, TMP_69.$$arity = 1);

    Opal.cdecl($scope, 'INFINITY', Infinity);

    Opal.cdecl($scope, 'MAX', Number.MAX_VALUE);

    Opal.cdecl($scope, 'MIN', Number.MIN_VALUE);

    Opal.cdecl($scope, 'NAN', NaN);

    Opal.cdecl($scope, 'DIG', 15);

    Opal.cdecl($scope, 'MANT_DIG', 53);

    Opal.cdecl($scope, 'RADIX', 2);

    if ((($a = (typeof(Number.EPSILON) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      return Opal.cdecl($scope, 'EPSILON', Number.EPSILON)
      } else {
      return Opal.cdecl($scope, 'EPSILON', 2.2204460492503130808472633361816E-16)
    };
  })($scope.base, $scope.get('Numeric'));
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/range"] = function(Opal) {
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$attr_reader', '$<=>', '$raise', '$include?', '$<=', '$<', '$enum_for', '$upto', '$to_proc', '$succ', '$!', '$==', '$===', '$exclude_end?', '$eql?', '$begin', '$end', '$-', '$abs', '$to_i', '$inspect', '$[]']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Range(){};
    var self = $Range = $klass($base, $super, 'Range', $Range);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13;

    def.begin = def.exclude = def.end = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_range = true;

    self.$attr_reader("begin", "end");

    Opal.defn(self, '$initialize', TMP_1 = function $$initialize(first, last, exclude) {
      var $a, self = this;

      if (exclude == null) {
        exclude = false;
      }
      if ((($a = first['$<=>'](last)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'))
      };
      self.begin = first;
      self.end = last;
      return self.exclude = exclude;
    }, TMP_1.$$arity = -3);

    Opal.defn(self, '$==', TMP_2 = function(other) {
      var self = this;

      
      if (!other.$$is_range) {
        return false;
      }

      return self.exclude === other.exclude &&
             self.begin   ==  other.begin &&
             self.end     ==  other.end;
    
    }, TMP_2.$$arity = 1);

    Opal.defn(self, '$===', TMP_3 = function(value) {
      var self = this;

      return self['$include?'](value);
    }, TMP_3.$$arity = 1);

    Opal.defn(self, '$cover?', TMP_4 = function(value) {
      var $a, $b, self = this;

      return ($a = $rb_le(self.begin, value), $a !== false && $a !== nil && $a != null ?((function() {if ((($b = self.exclude) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        return $rb_lt(value, self.end)
        } else {
        return $rb_le(value, self.end)
      }; return nil; })()) : $a);
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$each', TMP_5 = function $$each() {
      var $a, $b, $c, self = this, $iter = TMP_5.$$p, block = $iter || nil, current = nil, last = nil;

      TMP_5.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      
      var i, limit;

      if (self.begin.$$is_number && self.end.$$is_number) {
        if (self.begin % 1 !== 0 || self.end % 1 !== 0) {
          self.$raise($scope.get('TypeError'), "can't iterate from Float")
        }

        for (i = self.begin, limit = self.end + (function() {if ((($a = self.exclude) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return 0
        } else {
        return 1
      }; return nil; })(); i < limit; i++) {
          block(i);
        }

        return self;
      }

      if (self.begin.$$is_string && self.end.$$is_string) {
        ($a = ($b = self.begin).$upto, $a.$$p = block.$to_proc(), $a).call($b, self.end, self.exclude)
        return self;
      }
    ;
      current = self.begin;
      last = self.end;
      while ((($c = $rb_lt(current, last)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
      Opal.yield1(block, current);
      current = current.$succ();};
      if ((($a = ($c = self.exclude['$!'](), $c !== false && $c !== nil && $c != null ?current['$=='](last) : $c)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        Opal.yield1(block, current)};
      return self;
    }, TMP_5.$$arity = 0);

    Opal.defn(self, '$eql?', TMP_6 = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Range')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = self.exclude['$==='](other['$exclude_end?']()), $b !== false && $b !== nil && $b != null ?self.begin['$eql?'](other.$begin()) : $b), $a !== false && $a !== nil && $a != null ?self.end['$eql?'](other.$end()) : $a);
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$exclude_end?', TMP_7 = function() {
      var self = this;

      return self.exclude;
    }, TMP_7.$$arity = 0);

    Opal.alias(self, 'first', 'begin');

    Opal.alias(self, 'include?', 'cover?');

    Opal.alias(self, 'last', 'end');

    Opal.defn(self, '$max', TMP_8 = function $$max() {
      var $a, $b, self = this, $iter = TMP_8.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_8.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if (($yield !== nil)) {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'max', TMP_8, false)), $a.$$p = $iter, $a).apply($b, $zuper)
        } else {
        return self.exclude ? self.end - 1 : self.end;
      };
    }, TMP_8.$$arity = 0);

    Opal.alias(self, 'member?', 'cover?');

    Opal.defn(self, '$min', TMP_9 = function $$min() {
      var $a, $b, self = this, $iter = TMP_9.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_9.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      if (($yield !== nil)) {
        return ($a = ($b = self, Opal.find_super_dispatcher(self, 'min', TMP_9, false)), $a.$$p = $iter, $a).apply($b, $zuper)
        } else {
        return self.begin
      };
    }, TMP_9.$$arity = 0);

    Opal.alias(self, 'member?', 'include?');

    Opal.defn(self, '$size', TMP_10 = function $$size() {
      var $a, $b, self = this, _begin = nil, _end = nil, infinity = nil;

      _begin = self.begin;
      _end = self.end;
      if ((($a = self.exclude) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        _end = $rb_minus(_end, 1)};
      if ((($a = ($b = $scope.get('Numeric')['$==='](_begin), $b !== false && $b !== nil && $b != null ?$scope.get('Numeric')['$==='](_end) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      if ((($a = $rb_lt(_end, _begin)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return 0};
      infinity = (($scope.get('Float')).$$scope.get('INFINITY'));
      if ((($a = ((($b = infinity['$=='](_begin.$abs())) !== false && $b !== nil && $b != null) ? $b : _end.$abs()['$=='](infinity))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return infinity};
      return ((Math.abs(_end - _begin) + 1)).$to_i();
    }, TMP_10.$$arity = 0);

    Opal.defn(self, '$step', TMP_11 = function $$step(n) {
      var self = this;

      if (n == null) {
        n = 1;
      }
      return self.$raise($scope.get('NotImplementedError'));
    }, TMP_11.$$arity = -1);

    Opal.defn(self, '$to_s', TMP_12 = function $$to_s() {
      var self = this;

      return self.begin.$inspect() + (self.exclude ? '...' : '..') + self.end.$inspect();
    }, TMP_12.$$arity = 0);

    Opal.alias(self, 'inspect', 'to_s');

    return (Opal.defn(self, '$marshal_load', TMP_13 = function $$marshal_load(args) {
      var self = this;

      self.begin = args['$[]']("begin");
      self.end = args['$[]']("end");
      return self.exclude = args['$[]']("excl");
    }, TMP_13.$$arity = 1), nil) && 'marshal_load';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/proc"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise', '$coerce_to!']);
  return (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10;

    def.$$is_proc = true;

    def.$$is_lambda = false;

    Opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil && block != null) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create a Proc object without a block")
      };
      return block;
    }, TMP_1.$$arity = 0);

    Opal.defn(self, '$call', TMP_2 = function $$call($a_rest) {
      var self = this, args, $iter = TMP_2.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_2.$$p = null;
      
      if (block !== nil) {
        self.$$p = block;
      }

      var result, $brk = self.$$brk;

      if ($brk) {
        try {
          if (self.$$is_lambda) {
            result = self.apply(null, args);
          }
          else {
            result = Opal.yieldX(self, args);
          }
        } catch (err) {
          if (err === $brk) {
            return $brk.$v
          }
          else {
            throw err
          }
        }
      }
      else {
        if (self.$$is_lambda) {
          result = self.apply(null, args);
        }
        else {
          result = Opal.yieldX(self, args);
        }
      }

      return result;
    
    }, TMP_2.$$arity = -1);

    Opal.alias(self, '[]', 'call');

    Opal.alias(self, '===', 'call');

    Opal.alias(self, 'yield', 'call');

    Opal.defn(self, '$to_proc', TMP_3 = function $$to_proc() {
      var self = this;

      return self;
    }, TMP_3.$$arity = 0);

    Opal.defn(self, '$lambda?', TMP_4 = function() {
      var self = this;

      return !!self.$$is_lambda;
    }, TMP_4.$$arity = 0);

    Opal.defn(self, '$arity', TMP_5 = function $$arity() {
      var self = this;

      
      if (self.$$is_curried) {
        return -1;
      } else {
        return self.$$arity;
      }
    
    }, TMP_5.$$arity = 0);

    Opal.defn(self, '$source_location', TMP_6 = function $$source_location() {
      var self = this;

      if (self.$$is_curried) { return nil; }
      return nil;
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$binding', TMP_7 = function $$binding() {
      var self = this;

      if (self.$$is_curried) { self.$raise($scope.get('ArgumentError'), "Can't create Binding") };
      return nil;
    }, TMP_7.$$arity = 0);

    Opal.defn(self, '$parameters', TMP_8 = function $$parameters() {
      var self = this;

      
      if (self.$$is_curried) {
        return [["rest"]];
      } else if (self.$$parameters) {
        if (self.$$is_lambda) {
          return self.$$parameters;
        } else {
          var result = [], i, length;

          for (i = 0, length = self.$$parameters.length; i < length; i++) {
            var parameter = self.$$parameters[i];

            if (parameter[0] === 'req') {
              // required arguments always have name
              parameter = ['opt', parameter[1]];
            }

            result.push(parameter);
          }

          return result;
        }
      } else {
        return [];
      }
    ;
    }, TMP_8.$$arity = 0);

    Opal.defn(self, '$curry', TMP_9 = function $$curry(arity) {
      var self = this;

      
      if (arity === undefined) {
        arity = self.length;
      }
      else {
        arity = $scope.get('Opal')['$coerce_to!'](arity, $scope.get('Integer'), "to_int");
        if (self.$$is_lambda && arity !== self.length) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arity) + " for " + (self.length) + ")")
        }
      }

      function curried () {
        var args = $slice.call(arguments),
            length = args.length,
            result;

        if (length > arity && self.$$is_lambda && !self.$$is_curried) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (length) + " for " + (arity) + ")")
        }

        if (length >= arity) {
          return self.$call.apply(self, args);
        }

        result = function () {
          return curried.apply(null,
            args.concat($slice.call(arguments)));
        }
        result.$$is_lambda = self.$$is_lambda;
        result.$$is_curried = true;

        return result;
      };

      curried.$$is_lambda = self.$$is_lambda;
      curried.$$is_curried = true;
      return curried;
    
    }, TMP_9.$$arity = -1);

    Opal.defn(self, '$dup', TMP_10 = function $$dup() {
      var self = this;

      
      var original_proc = self.$$original_proc || self,
          proc = function () {
            return original_proc.apply(this, arguments);
          };

      for (var prop in self) {
        if (self.hasOwnProperty(prop)) {
          proc[prop] = self[prop];
        }
      }

      return proc;
    
    }, TMP_10.$$arity = 0);

    return Opal.alias(self, 'clone', 'dup');
  })($scope.base, Function)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/method"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$attr_reader', '$class', '$arity', '$new', '$name']);
  (function($base, $super) {
    function $Method(){};
    var self = $Method = $klass($base, $super, 'Method', $Method);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7;

    def.method = def.receiver = def.owner = def.name = nil;
    self.$attr_reader("owner", "receiver", "name");

    Opal.defn(self, '$initialize', TMP_1 = function $$initialize(receiver, method, name) {
      var self = this;

      self.receiver = receiver;
      self.owner = receiver.$class();
      self.name = name;
      return self.method = method;
    }, TMP_1.$$arity = 3);

    Opal.defn(self, '$arity', TMP_2 = function $$arity() {
      var self = this;

      return self.method.$arity();
    }, TMP_2.$$arity = 0);

    Opal.defn(self, '$parameters', TMP_3 = function $$parameters() {
      var self = this;

      return self.method.$$parameters;
    }, TMP_3.$$arity = 0);

    Opal.defn(self, '$call', TMP_4 = function $$call($a_rest) {
      var self = this, args, $iter = TMP_4.$$p, block = $iter || nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_4.$$p = null;
      
      self.method.$$p = block;

      return self.method.apply(self.receiver, args);
    ;
    }, TMP_4.$$arity = -1);

    Opal.alias(self, '[]', 'call');

    Opal.defn(self, '$unbind', TMP_5 = function $$unbind() {
      var self = this;

      return $scope.get('UnboundMethod').$new(self.owner, self.method, self.name);
    }, TMP_5.$$arity = 0);

    Opal.defn(self, '$to_proc', TMP_6 = function $$to_proc() {
      var self = this;

      
      var proc = function () { return self.$call.apply(self, $slice.call(arguments)); };
      proc.$$unbound = self.method;
      proc.$$is_lambda = true;
      return proc;
    
    }, TMP_6.$$arity = 0);

    return (Opal.defn(self, '$inspect', TMP_7 = function $$inspect() {
      var self = this;

      return "#<Method: " + (self.receiver.$class()) + "#" + (self.name) + ">";
    }, TMP_7.$$arity = 0), nil) && 'inspect';
  })($scope.base, null);
  return (function($base, $super) {
    function $UnboundMethod(){};
    var self = $UnboundMethod = $klass($base, $super, 'UnboundMethod', $UnboundMethod);

    var def = self.$$proto, $scope = self.$$scope, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12;

    def.method = def.name = def.owner = nil;
    self.$attr_reader("owner", "name");

    Opal.defn(self, '$initialize', TMP_8 = function $$initialize(owner, method, name) {
      var self = this;

      self.owner = owner;
      self.method = method;
      return self.name = name;
    }, TMP_8.$$arity = 3);

    Opal.defn(self, '$arity', TMP_9 = function $$arity() {
      var self = this;

      return self.method.$arity();
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$parameters', TMP_10 = function $$parameters() {
      var self = this;

      return self.method.$$parameters;
    }, TMP_10.$$arity = 0);

    Opal.defn(self, '$bind', TMP_11 = function $$bind(object) {
      var self = this;

      return $scope.get('Method').$new(object, self.method, self.name);
    }, TMP_11.$$arity = 1);

    return (Opal.defn(self, '$inspect', TMP_12 = function $$inspect() {
      var self = this;

      return "#<UnboundMethod: " + (self.owner.$name()) + "#" + (self.name) + ">";
    }, TMP_12.$$arity = 0), nil) && 'inspect';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/variables"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $gvars = Opal.gvars, $hash2 = Opal.hash2;

  Opal.add_stubs(['$new']);
  $gvars["&"] = $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
  $gvars.LOADED_FEATURES = $gvars["\""] = Opal.loaded_features;
  $gvars.LOAD_PATH = $gvars[":"] = [];
  $gvars["/"] = "\n";
  $gvars[","] = nil;
  Opal.cdecl($scope, 'ARGV', []);
  Opal.cdecl($scope, 'ARGF', $scope.get('Object').$new());
  Opal.cdecl($scope, 'ENV', $hash2([], {}));
  $gvars.VERBOSE = false;
  $gvars.DEBUG = false;
  return $gvars.SAFE = 0;
};

/* Generated by Opal 0.10.3 */
Opal.modules["opal/regexp_anchors"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$==', '$new']);
  return (function($base) {
    var $Opal, self = $Opal = $module($base, 'Opal');

    var def = self.$$proto, $scope = self.$$scope;

    Opal.cdecl($scope, 'REGEXP_START', (function() {if ($scope.get('RUBY_ENGINE')['$==']("opal")) {
      return "^"}; return nil; })());

    Opal.cdecl($scope, 'REGEXP_END', (function() {if ($scope.get('RUBY_ENGINE')['$==']("opal")) {
      return "$"}; return nil; })());

    Opal.cdecl($scope, 'FORBIDDEN_STARTING_IDENTIFIER_CHARS', "\\u0001-\\u002F\\u003A-\\u0040\\u005B-\\u005E\\u0060\\u007B-\\u007F");

    Opal.cdecl($scope, 'FORBIDDEN_ENDING_IDENTIFIER_CHARS', "\\u0001-\\u0020\\u0022-\\u002F\\u003A-\\u003E\\u0040\\u005B-\\u005E\\u0060\\u007B-\\u007F");

    Opal.cdecl($scope, 'INLINE_IDENTIFIER_REGEXP', $scope.get('Regexp').$new("[^" + ($scope.get('FORBIDDEN_STARTING_IDENTIFIER_CHARS')) + "]*[^" + ($scope.get('FORBIDDEN_ENDING_IDENTIFIER_CHARS')) + "]"));

    Opal.cdecl($scope, 'FORBIDDEN_CONST_NAME_CHARS', "\\u0001-\\u0020\\u0021-\\u002F\\u003B-\\u003F\\u0040\\u005B-\\u005E\\u0060\\u007B-\\u007F");

    Opal.cdecl($scope, 'CONST_NAME_REGEXP', $scope.get('Regexp').$new("" + ($scope.get('REGEXP_START')) + "(::)?[A-Z][^" + ($scope.get('FORBIDDEN_CONST_NAME_CHARS')) + "]*" + ($scope.get('REGEXP_END'))));
  })($scope.base)
};

/* Generated by Opal 0.10.3 */
Opal.modules["opal/mini"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("opal/base");
  self.$require("corelib/nil");
  self.$require("corelib/boolean");
  self.$require("corelib/string");
  self.$require("corelib/comparable");
  self.$require("corelib/enumerable");
  self.$require("corelib/enumerator");
  self.$require("corelib/array");
  self.$require("corelib/hash");
  self.$require("corelib/number");
  self.$require("corelib/range");
  self.$require("corelib/proc");
  self.$require("corelib/method");
  self.$require("corelib/regexp");
  self.$require("corelib/variables");
  return self.$require("opal/regexp_anchors");
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/string/inheritance"] = function(Opal) {
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$require', '$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$class', '$clone', '$respond_to?', '$==', '$inspect', '$+', '$*', '$map', '$split', '$enum_for', '$each_line', '$to_a', '$%', '$-']);
  self.$require("corelib/string");
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope, TMP_1;

    return (Opal.defs(self, '$inherited', TMP_1 = function $$inherited(klass) {
      var self = this, replace = nil;

      replace = $scope.get('Class').$new((($scope.get('String')).$$scope.get('Wrapper')));
      
      klass.$$proto         = replace.$$proto;
      klass.$$proto.$$class = klass;
      klass.$$alloc         = replace.$$alloc;
      klass.$$parent        = (($scope.get('String')).$$scope.get('Wrapper'));

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
    
    }, TMP_1.$$arity = 1), nil) && 'inherited'
  })($scope.base, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self.$$proto, $scope = self.$$scope, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_15, TMP_16, TMP_17, TMP_19, TMP_20, TMP_21;

    def.literal = nil;
    def.$$is_string = true;

    Opal.defs(self, '$allocate', TMP_2 = function $$allocate(string) {
      var $a, $b, self = this, $iter = TMP_2.$$p, $yield = $iter || nil, obj = nil;

      if (string == null) {
        string = "";
      }
      TMP_2.$$p = null;
      obj = ($a = ($b = self, Opal.find_super_dispatcher(self, 'allocate', TMP_2, false, $Wrapper)), $a.$$p = null, $a).call($b);
      obj.literal = string;
      return obj;
    }, TMP_2.$$arity = -1);

    Opal.defs(self, '$new', TMP_3 = function($a_rest) {
      var $b, $c, self = this, args, $iter = TMP_3.$$p, block = $iter || nil, obj = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_3.$$p = null;
      obj = self.$allocate();
      ($b = ($c = obj).$initialize, $b.$$p = block.$to_proc(), $b).apply($c, Opal.to_a(args));
      return obj;
    }, TMP_3.$$arity = -1);

    Opal.defs(self, '$[]', TMP_4 = function($a_rest) {
      var self = this, objects;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      objects = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        objects[$arg_idx - 0] = arguments[$arg_idx];
      }
      return self.$allocate(objects);
    }, TMP_4.$$arity = -1);

    Opal.defn(self, '$initialize', TMP_5 = function $$initialize(string) {
      var self = this;

      if (string == null) {
        string = "";
      }
      return self.literal = string;
    }, TMP_5.$$arity = -1);

    Opal.defn(self, '$method_missing', TMP_6 = function $$method_missing($a_rest) {
      var $b, $c, self = this, args, $iter = TMP_6.$$p, block = $iter || nil, result = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      TMP_6.$$p = null;
      result = ($b = ($c = self.literal).$__send__, $b.$$p = block.$to_proc(), $b).apply($c, Opal.to_a(args));
      if ((($b = result.$$is_string != null) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        if ((($b = result == self.literal) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          return self
          } else {
          return self.$class().$allocate(result)
        }
        } else {
        return result
      };
    }, TMP_6.$$arity = -1);

    Opal.defn(self, '$initialize_copy', TMP_7 = function $$initialize_copy(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$respond_to?', TMP_8 = function(name, $a_rest) {
      var $b, $c, $d, self = this, $iter = TMP_8.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_8.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      return ((($b = ($c = ($d = self, Opal.find_super_dispatcher(self, 'respond_to?', TMP_8, false)), $c.$$p = $iter, $c).apply($d, $zuper)) !== false && $b !== nil && $b != null) ? $b : self.literal['$respond_to?'](name));
    }, TMP_8.$$arity = -2);

    Opal.defn(self, '$==', TMP_9 = function(other) {
      var self = this;

      return self.literal['$=='](other);
    }, TMP_9.$$arity = 1);

    Opal.alias(self, 'eql?', '==');

    Opal.alias(self, '===', '==');

    Opal.defn(self, '$to_s', TMP_10 = function $$to_s() {
      var self = this;

      return self.literal;
    }, TMP_10.$$arity = 0);

    Opal.alias(self, 'to_str', 'to_s');

    Opal.defn(self, '$inspect', TMP_11 = function $$inspect() {
      var self = this;

      return self.literal.$inspect();
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$+', TMP_12 = function(other) {
      var self = this;

      return $rb_plus(self.literal, other);
    }, TMP_12.$$arity = 1);

    Opal.defn(self, '$*', TMP_13 = function(other) {
      var self = this;

      
      var result = $rb_times(self.literal, other);

      if (result.$$is_string) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    }, TMP_13.$$arity = 1);

    Opal.defn(self, '$split', TMP_15 = function $$split(pattern, limit) {
      var $a, $b, TMP_14, self = this;

      return ($a = ($b = self.literal.$split(pattern, limit)).$map, $a.$$p = (TMP_14 = function(str){var self = TMP_14.$$s || this;
if (str == null) str = nil;
      return self.$class().$allocate(str)}, TMP_14.$$s = self, TMP_14.$$arity = 1, TMP_14), $a).call($b);
    }, TMP_15.$$arity = -1);

    Opal.defn(self, '$replace', TMP_16 = function $$replace(string) {
      var self = this;

      return self.literal = string;
    }, TMP_16.$$arity = 1);

    Opal.defn(self, '$each_line', TMP_17 = function $$each_line(separator) {
      var $a, $b, TMP_18, self = this, $iter = TMP_17.$$p, $yield = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"];
      }
      TMP_17.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_line", separator)
      };
      return ($a = ($b = self.literal).$each_line, $a.$$p = (TMP_18 = function(str){var self = TMP_18.$$s || this;
if (str == null) str = nil;
      return Opal.yield1($yield, self.$class().$allocate(str));}, TMP_18.$$s = self, TMP_18.$$arity = 1, TMP_18), $a).call($b, separator);
    }, TMP_17.$$arity = -1);

    Opal.defn(self, '$lines', TMP_19 = function $$lines(separator) {
      var $a, $b, self = this, $iter = TMP_19.$$p, block = $iter || nil, e = nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"];
      }
      TMP_19.$$p = null;
      e = ($a = ($b = self).$each_line, $a.$$p = block.$to_proc(), $a).call($b, separator);
      if (block !== false && block !== nil && block != null) {
        return self
        } else {
        return e.$to_a()
      };
    }, TMP_19.$$arity = -1);

    Opal.defn(self, '$%', TMP_20 = function(data) {
      var self = this;

      return self.literal['$%'](data);
    }, TMP_20.$$arity = 1);

    return (Opal.defn(self, '$instance_variables', TMP_21 = function $$instance_variables() {
      var $a, $b, self = this, $iter = TMP_21.$$p, $yield = $iter || nil, $zuper = nil, $zuper_index = nil, $zuper_length = nil;

      TMP_21.$$p = null;
      $zuper = [];
      
      for($zuper_index = 0; $zuper_index < arguments.length; $zuper_index++) {
        $zuper[$zuper_index] = arguments[$zuper_index];
      }
      return $rb_minus(($a = ($b = self, Opal.find_super_dispatcher(self, 'instance_variables', TMP_21, false)), $a.$$p = $iter, $a).apply($b, $zuper), ["@literal"]);
    }, TMP_21.$$arity = 0), nil) && 'instance_variables';
  })($scope.get('String'), null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/string/encoding"] = function(Opal) {
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var $a, $b, TMP_13, $c, TMP_16, $d, TMP_19, self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$+', '$[]', '$new', '$to_proc', '$each', '$const_set', '$sub', '$upcase', '$const_get', '$===', '$==', '$name', '$include?', '$names', '$constants', '$raise', '$attr_accessor', '$attr_reader', '$register', '$length', '$bytes', '$to_a', '$each_byte', '$bytesize', '$enum_for', '$force_encoding', '$dup', '$coerce_to!', '$find', '$nil?', '$getbyte']);
  self.$require("corelib/string");
  (function($base, $super) {
    function $Encoding(){};
    var self = $Encoding = $klass($base, $super, 'Encoding', $Encoding);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12;

    def.ascii = def.dummy = def.name = nil;
    Opal.defs(self, '$register', TMP_1 = function $$register(name, options) {
      var $a, $b, $c, TMP_2, self = this, $iter = TMP_1.$$p, block = $iter || nil, names = nil, encoding = nil;

      if (options == null) {
        options = $hash2([], {});
      }
      TMP_1.$$p = null;
      names = $rb_plus([name], (((($a = options['$[]']("aliases")) !== false && $a !== nil && $a != null) ? $a : [])));
      encoding = ($a = ($b = $scope.get('Class')).$new, $a.$$p = block.$to_proc(), $a).call($b, self).$new(name, names, ((($a = options['$[]']("ascii")) !== false && $a !== nil && $a != null) ? $a : false), ((($a = options['$[]']("dummy")) !== false && $a !== nil && $a != null) ? $a : false));
      return ($a = ($c = names).$each, $a.$$p = (TMP_2 = function(name){var self = TMP_2.$$s || this;
if (name == null) name = nil;
      return self.$const_set(name.$sub("-", "_"), encoding)}, TMP_2.$$s = self, TMP_2.$$arity = 1, TMP_2), $a).call($c);
    }, TMP_1.$$arity = -2);

    Opal.defs(self, '$find', TMP_4 = function $$find(name) {try {

      var $a, $b, TMP_3, self = this, upcase = nil;

      upcase = name.$upcase();
      ($a = ($b = self.$constants()).$each, $a.$$p = (TMP_3 = function(const$){var self = TMP_3.$$s || this, $c, $d, encoding = nil;
if (const$ == null) const$ = nil;
      encoding = self.$const_get(const$);
        if ((($c = $scope.get('Encoding')['$==='](encoding)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
          } else {
          return nil;
        };
        if ((($c = ((($d = encoding.$name()['$=='](upcase)) !== false && $d !== nil && $d != null) ? $d : encoding.$names()['$include?'](upcase))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
          Opal.ret(encoding)
          } else {
          return nil
        };}, TMP_3.$$s = self, TMP_3.$$arity = 1, TMP_3), $a).call($b);
      return self.$raise($scope.get('ArgumentError'), "unknown encoding name - " + (name));
      } catch ($returner) { if ($returner === Opal.returner) { return $returner.$v } throw $returner; }
    }, TMP_4.$$arity = 1);

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      return self.$attr_accessor("default_external")
    })(Opal.get_singleton_class(self));

    self.$attr_reader("name", "names");

    Opal.defn(self, '$initialize', TMP_5 = function $$initialize(name, names, ascii, dummy) {
      var self = this;

      self.name = name;
      self.names = names;
      self.ascii = ascii;
      return self.dummy = dummy;
    }, TMP_5.$$arity = 4);

    Opal.defn(self, '$ascii_compatible?', TMP_6 = function() {
      var self = this;

      return self.ascii;
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$dummy?', TMP_7 = function() {
      var self = this;

      return self.dummy;
    }, TMP_7.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_8 = function $$to_s() {
      var self = this;

      return self.name;
    }, TMP_8.$$arity = 0);

    Opal.defn(self, '$inspect', TMP_9 = function $$inspect() {
      var $a, self = this;

      return "#<Encoding:" + (self.name) + ((function() {if ((($a = self.dummy) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return " (dummy)"
        } else {
        return nil
      }; return nil; })()) + ">";
    }, TMP_9.$$arity = 0);

    Opal.defn(self, '$each_byte', TMP_10 = function $$each_byte($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'));
    }, TMP_10.$$arity = -1);

    Opal.defn(self, '$getbyte', TMP_11 = function $$getbyte($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'));
    }, TMP_11.$$arity = -1);

    Opal.defn(self, '$bytesize', TMP_12 = function $$bytesize($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'));
    }, TMP_12.$$arity = -1);

    (function($base, $super) {
      function $EncodingError(){};
      var self = $EncodingError = $klass($base, $super, 'EncodingError', $EncodingError);

      var def = self.$$proto, $scope = self.$$scope;

      return nil;
    })($scope.base, $scope.get('StandardError'));

    return (function($base, $super) {
      function $CompatibilityError(){};
      var self = $CompatibilityError = $klass($base, $super, 'CompatibilityError', $CompatibilityError);

      var def = self.$$proto, $scope = self.$$scope;

      return nil;
    })($scope.base, $scope.get('EncodingError'));
  })($scope.base, null);
  ($a = ($b = $scope.get('Encoding')).$register, $a.$$p = (TMP_13 = function(){var self = TMP_13.$$s || this, TMP_14, TMP_15;

  Opal.def(self, '$each_byte', TMP_14 = function $$each_byte(string) {
      var self = this, $iter = TMP_14.$$p, block = $iter || nil;

      TMP_14.$$p = null;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);

        if (code <= 0x7f) {
          Opal.yield1(block, code);
        }
        else {
          var encoded = encodeURIComponent(string.charAt(i)).substr(1).split('%');

          for (var j = 0, encoded_length = encoded.length; j < encoded_length; j++) {
            Opal.yield1(block, parseInt(encoded[j], 16));
          }
        }
      }
    
    }, TMP_14.$$arity = 1);
    return (Opal.def(self, '$bytesize', TMP_15 = function $$bytesize() {
      var self = this;

      return self.$bytes().$length();
    }, TMP_15.$$arity = 0), nil) && 'bytesize';}, TMP_13.$$s = self, TMP_13.$$arity = 0, TMP_13), $a).call($b, "UTF-8", $hash2(["aliases", "ascii"], {"aliases": ["CP65001"], "ascii": true}));
  ($a = ($c = $scope.get('Encoding')).$register, $a.$$p = (TMP_16 = function(){var self = TMP_16.$$s || this, TMP_17, TMP_18;

  Opal.def(self, '$each_byte', TMP_17 = function $$each_byte(string) {
      var self = this, $iter = TMP_17.$$p, block = $iter || nil;

      TMP_17.$$p = null;
      
      for (var i = 0, length = string.length; i < length; i++) {
        var code = string.charCodeAt(i);

        Opal.yield1(block, code & 0xff);
        Opal.yield1(block, code >> 8);
      }
    
    }, TMP_17.$$arity = 1);
    return (Opal.def(self, '$bytesize', TMP_18 = function $$bytesize() {
      var self = this;

      return self.$bytes().$length();
    }, TMP_18.$$arity = 0), nil) && 'bytesize';}, TMP_16.$$s = self, TMP_16.$$arity = 0, TMP_16), $a).call($c, "UTF-16LE");
  ($a = ($d = $scope.get('Encoding')).$register, $a.$$p = (TMP_19 = function(){var self = TMP_19.$$s || this, TMP_20, TMP_21;

  Opal.def(self, '$each_byte', TMP_20 = function $$each_byte(string) {
      var self = this, $iter = TMP_20.$$p, block = $iter || nil;

      TMP_20.$$p = null;
      
      for (var i = 0, length = string.length; i < length; i++) {
        Opal.yield1(block, string.charCodeAt(i) & 0xff);
      }
    
    }, TMP_20.$$arity = 1);
    return (Opal.def(self, '$bytesize', TMP_21 = function $$bytesize() {
      var self = this;

      return self.$bytes().$length();
    }, TMP_21.$$arity = 0), nil) && 'bytesize';}, TMP_19.$$s = self, TMP_19.$$arity = 0, TMP_19), $a).call($d, "ASCII-8BIT", $hash2(["aliases", "ascii"], {"aliases": ["BINARY"], "ascii": true}));
  return (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28;

    def.encoding = nil;
    String.prototype.encoding = (($scope.get('Encoding')).$$scope.get('UTF_16LE'));

    Opal.defn(self, '$bytes', TMP_22 = function $$bytes() {
      var self = this;

      return self.$each_byte().$to_a();
    }, TMP_22.$$arity = 0);

    Opal.defn(self, '$bytesize', TMP_23 = function $$bytesize() {
      var self = this;

      return self.encoding.$bytesize(self);
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$each_byte', TMP_24 = function $$each_byte() {
      var $a, $b, self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_byte")
      };
      ($a = ($b = self.encoding).$each_byte, $a.$$p = block.$to_proc(), $a).call($b, self);
      return self;
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$encode', TMP_25 = function $$encode(encoding) {
      var self = this;

      return self.$dup().$force_encoding(encoding);
    }, TMP_25.$$arity = 1);

    Opal.defn(self, '$encoding', TMP_26 = function $$encoding() {
      var self = this;

      return self.encoding;
    }, TMP_26.$$arity = 0);

    Opal.defn(self, '$force_encoding', TMP_27 = function $$force_encoding(encoding) {
      var $a, self = this;

      encoding = $scope.get('Opal')['$coerce_to!'](encoding, $scope.get('String'), "to_str");
      encoding = $scope.get('Encoding').$find(encoding);
      if (encoding['$=='](self.encoding)) {
        return self};
      if ((($a = encoding['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "unknown encoding name - " + (encoding))};
      
      var result = new String(self);
      result.encoding = encoding;

      return result;
    
    }, TMP_27.$$arity = 1);

    return (Opal.defn(self, '$getbyte', TMP_28 = function $$getbyte(idx) {
      var self = this;

      return self.encoding.$getbyte(self, idx);
    }, TMP_28.$$arity = 1), nil) && 'getbyte';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/math"] = function(Opal) {
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$new', '$raise', '$Float', '$type_error', '$Integer', '$module_function', '$checked', '$float!', '$===', '$gamma', '$-', '$integer!', '$/', '$infinite?']);
  return (function($base) {
    var $Math, self = $Math = $module($base, 'Math');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, $a, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29;

    Opal.cdecl($scope, 'E', Math.E);

    Opal.cdecl($scope, 'PI', Math.PI);

    Opal.cdecl($scope, 'DomainError', $scope.get('Class').$new($scope.get('StandardError')));

    Opal.defs(self, '$checked', TMP_1 = function $$checked(method, $a_rest) {
      var self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      
      if (isNaN(args[0]) || (args.length == 2 && isNaN(args[1]))) {
        return NaN;
      }

      var result = Math[method].apply(null, args);

      if (isNaN(result)) {
        self.$raise($scope.get('DomainError'), "Numerical argument is out of domain - \"" + (method) + "\"");
      }

      return result;
    
    }, TMP_1.$$arity = -2);

    Opal.defs(self, '$float!', TMP_2 = function(value) {
      var self = this;

      try {
        return self.$Float(value)
      } catch ($err) {
        if (Opal.rescue($err, [$scope.get('ArgumentError')])) {
          try {
            return self.$raise($scope.get('Opal').$type_error(value, $scope.get('Float')))
          } finally { Opal.pop_exception() }
        } else { throw $err; }
      };
    }, TMP_2.$$arity = 1);

    Opal.defs(self, '$integer!', TMP_3 = function(value) {
      var self = this;

      try {
        return self.$Integer(value)
      } catch ($err) {
        if (Opal.rescue($err, [$scope.get('ArgumentError')])) {
          try {
            return self.$raise($scope.get('Opal').$type_error(value, $scope.get('Integer')))
          } finally { Opal.pop_exception() }
        } else { throw $err; }
      };
    }, TMP_3.$$arity = 1);

    self.$module_function();

    Opal.defn(self, '$acos', TMP_4 = function $$acos(x) {
      var self = this;

      return $scope.get('Math').$checked("acos", $scope.get('Math')['$float!'](x));
    }, TMP_4.$$arity = 1);

    if ((($a = (typeof(Math.acosh) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.acosh = function(x) {
        return Math.log(x + Math.sqrt(x * x - 1));
      }
    
    };

    Opal.defn(self, '$acosh', TMP_5 = function $$acosh(x) {
      var self = this;

      return $scope.get('Math').$checked("acosh", $scope.get('Math')['$float!'](x));
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$asin', TMP_6 = function $$asin(x) {
      var self = this;

      return $scope.get('Math').$checked("asin", $scope.get('Math')['$float!'](x));
    }, TMP_6.$$arity = 1);

    if ((($a = (typeof(Math.asinh) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.asinh = function(x) {
        return Math.log(x + Math.sqrt(x * x + 1))
      }
    ;
    };

    Opal.defn(self, '$asinh', TMP_7 = function $$asinh(x) {
      var self = this;

      return $scope.get('Math').$checked("asinh", $scope.get('Math')['$float!'](x));
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$atan', TMP_8 = function $$atan(x) {
      var self = this;

      return $scope.get('Math').$checked("atan", $scope.get('Math')['$float!'](x));
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$atan2', TMP_9 = function $$atan2(y, x) {
      var self = this;

      return $scope.get('Math').$checked("atan2", $scope.get('Math')['$float!'](y), $scope.get('Math')['$float!'](x));
    }, TMP_9.$$arity = 2);

    if ((($a = (typeof(Math.atanh) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.atanh = function(x) {
        return 0.5 * Math.log((1 + x) / (1 - x));
      }
    
    };

    Opal.defn(self, '$atanh', TMP_10 = function $$atanh(x) {
      var self = this;

      return $scope.get('Math').$checked("atanh", $scope.get('Math')['$float!'](x));
    }, TMP_10.$$arity = 1);

    if ((($a = (typeof(Math.cbrt) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.cbrt = function(x) {
        if (x == 0) {
          return 0;
        }

        if (x < 0) {
          return -Math.cbrt(-x);
        }

        var r  = x,
            ex = 0;

        while (r < 0.125) {
          r *= 8;
          ex--;
        }

        while (r > 1.0) {
          r *= 0.125;
          ex++;
        }

        r = (-0.46946116 * r + 1.072302) * r + 0.3812513;

        while (ex < 0) {
          r *= 0.5;
          ex++;
        }

        while (ex > 0) {
          r *= 2;
          ex--;
        }

        r = (2.0 / 3.0) * r + (1.0 / 3.0) * x / (r * r);
        r = (2.0 / 3.0) * r + (1.0 / 3.0) * x / (r * r);
        r = (2.0 / 3.0) * r + (1.0 / 3.0) * x / (r * r);
        r = (2.0 / 3.0) * r + (1.0 / 3.0) * x / (r * r);

        return r;
      }
    
    };

    Opal.defn(self, '$cbrt', TMP_11 = function $$cbrt(x) {
      var self = this;

      return $scope.get('Math').$checked("cbrt", $scope.get('Math')['$float!'](x));
    }, TMP_11.$$arity = 1);

    Opal.defn(self, '$cos', TMP_12 = function $$cos(x) {
      var self = this;

      return $scope.get('Math').$checked("cos", $scope.get('Math')['$float!'](x));
    }, TMP_12.$$arity = 1);

    if ((($a = (typeof(Math.cosh) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.cosh = function(x) {
        return (Math.exp(x) + Math.exp(-x)) / 2;
      }
    
    };

    Opal.defn(self, '$cosh', TMP_13 = function $$cosh(x) {
      var self = this;

      return $scope.get('Math').$checked("cosh", $scope.get('Math')['$float!'](x));
    }, TMP_13.$$arity = 1);

    if ((($a = (typeof(Math.erf) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.erf = function(x) {
        var A1 =  0.254829592,
            A2 = -0.284496736,
            A3 =  1.421413741,
            A4 = -1.453152027,
            A5 =  1.061405429,
            P  =  0.3275911;

        var sign = 1;

        if (x < 0) {
            sign = -1;
        }

        x = Math.abs(x);

        var t = 1.0 / (1.0 + P * x);
        var y = 1.0 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * Math.exp(-x * x);

        return sign * y;
      }
    
    };

    Opal.defn(self, '$erf', TMP_14 = function $$erf(x) {
      var self = this;

      return $scope.get('Math').$checked("erf", $scope.get('Math')['$float!'](x));
    }, TMP_14.$$arity = 1);

    if ((($a = (typeof(Math.erfc) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.erfc = function(x) {
        var z = Math.abs(x),
            t = 1.0 / (0.5 * z + 1.0);

        var A1 = t * 0.17087277 + -0.82215223,
            A2 = t * A1 + 1.48851587,
            A3 = t * A2 + -1.13520398,
            A4 = t * A3 + 0.27886807,
            A5 = t * A4 + -0.18628806,
            A6 = t * A5 + 0.09678418,
            A7 = t * A6 + 0.37409196,
            A8 = t * A7 + 1.00002368,
            A9 = t * A8,
            A10 = -z * z - 1.26551223 + A9;

        var a = t * Math.exp(A10);

        if (x < 0.0) {
          return 2.0 - a;
        }
        else {
          return a;
        }
      }
    
    };

    Opal.defn(self, '$erfc', TMP_15 = function $$erfc(x) {
      var self = this;

      return $scope.get('Math').$checked("erfc", $scope.get('Math')['$float!'](x));
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$exp', TMP_16 = function $$exp(x) {
      var self = this;

      return $scope.get('Math').$checked("exp", $scope.get('Math')['$float!'](x));
    }, TMP_16.$$arity = 1);

    Opal.defn(self, '$frexp', TMP_17 = function $$frexp(x) {
      var self = this;

      x = $scope.get('Math')['$float!'](x);
      
      if (isNaN(x)) {
        return [NaN, 0];
      }

      var ex   = Math.floor(Math.log(Math.abs(x)) / Math.log(2)) + 1,
          frac = x / Math.pow(2, ex);

      return [frac, ex];
    
    }, TMP_17.$$arity = 1);

    Opal.defn(self, '$gamma', TMP_18 = function $$gamma(n) {
      var self = this;

      n = $scope.get('Math')['$float!'](n);
      
      var i, t, x, value, result, twoN, threeN, fourN, fiveN;

      var G = 4.7421875;

      var P = [
         0.99999999999999709182,
         57.156235665862923517,
        -59.597960355475491248,
         14.136097974741747174,
        -0.49191381609762019978,
         0.33994649984811888699e-4,
         0.46523628927048575665e-4,
        -0.98374475304879564677e-4,
         0.15808870322491248884e-3,
        -0.21026444172410488319e-3,
         0.21743961811521264320e-3,
        -0.16431810653676389022e-3,
         0.84418223983852743293e-4,
        -0.26190838401581408670e-4,
         0.36899182659531622704e-5
      ];


      if (isNaN(n)) {
        return NaN;
      }

      if (n === 0 && 1 / n < 0) {
        return -Infinity;
      }

      if (n === -1 || n === -Infinity) {
        self.$raise($scope.get('DomainError'), "Numerical argument is out of domain - \"gamma\"");
      }

      if ($scope.get('Integer')['$==='](n)) {
        if (n <= 0) {
          return isFinite(n) ? Infinity : NaN;
        }

        if (n > 171) {
          return Infinity;
        }

        value  = n - 2;
        result = n - 1;

        while (value > 1) {
          result *= value;
          value--;
        }

        if (result == 0) {
          result = 1;
        }

        return result;
      }

      if (n < 0.5) {
        return Math.PI / (Math.sin(Math.PI * n) * $scope.get('Math').$gamma($rb_minus(1, n)));
      }

      if (n >= 171.35) {
        return Infinity;
      }

      if (n > 85.0) {
        twoN   = n * n;
        threeN = twoN * n;
        fourN  = threeN * n;
        fiveN  = fourN * n;

        return Math.sqrt(2 * Math.PI / n) * Math.pow((n / Math.E), n) *
          (1 + 1 / (12 * n) + 1 / (288 * twoN) - 139 / (51840 * threeN) -
          571 / (2488320 * fourN) + 163879 / (209018880 * fiveN) +
          5246819 / (75246796800 * fiveN * n));
      }

      n -= 1;
      x  = P[0];

      for (i = 1; i < P.length; ++i) {
        x += P[i] / (n + i);
      }

      t = n + G + 0.5;

      return Math.sqrt(2 * Math.PI) * Math.pow(t, n + 0.5) * Math.exp(-t) * x;
    
    }, TMP_18.$$arity = 1);

    if ((($a = (typeof(Math.hypot) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.hypot = function(x, y) {
        return Math.sqrt(x * x + y * y)
      }
    ;
    };

    Opal.defn(self, '$hypot', TMP_19 = function $$hypot(x, y) {
      var self = this;

      return $scope.get('Math').$checked("hypot", $scope.get('Math')['$float!'](x), $scope.get('Math')['$float!'](y));
    }, TMP_19.$$arity = 2);

    Opal.defn(self, '$ldexp', TMP_20 = function $$ldexp(mantissa, exponent) {
      var self = this;

      mantissa = $scope.get('Math')['$float!'](mantissa);
      exponent = $scope.get('Math')['$integer!'](exponent);
      
      if (isNaN(exponent)) {
        self.$raise($scope.get('RangeError'), "float NaN out of range of integer");
      }

      return mantissa * Math.pow(2, exponent);
    ;
    }, TMP_20.$$arity = 2);

    Opal.defn(self, '$lgamma', TMP_21 = function $$lgamma(n) {
      var self = this;

      
      if (n == -1) {
        return [Infinity, 1];
      }
      else {
        return [Math.log(Math.abs($scope.get('Math').$gamma(n))), $scope.get('Math').$gamma(n) < 0 ? -1 : 1];
      }
    ;
    }, TMP_21.$$arity = 1);

    Opal.defn(self, '$log', TMP_22 = function $$log(x, base) {
      var $a, self = this;

      if ((($a = $scope.get('String')['$==='](x)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('Opal').$type_error(x, $scope.get('Float')))};
      if ((($a = base == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('Math').$checked("log", $scope.get('Math')['$float!'](x))
        } else {
        if ((($a = $scope.get('String')['$==='](base)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('Opal').$type_error(base, $scope.get('Float')))};
        return $rb_divide($scope.get('Math').$checked("log", $scope.get('Math')['$float!'](x)), $scope.get('Math').$checked("log", $scope.get('Math')['$float!'](base)));
      };
    }, TMP_22.$$arity = -2);

    if ((($a = (typeof(Math.log10) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.log10 = function(x) {
        return Math.log(x) / Math.LN10;
      }
    
    };

    Opal.defn(self, '$log10', TMP_23 = function $$log10(x) {
      var $a, self = this;

      if ((($a = $scope.get('String')['$==='](x)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('Opal').$type_error(x, $scope.get('Float')))};
      return $scope.get('Math').$checked("log10", $scope.get('Math')['$float!'](x));
    }, TMP_23.$$arity = 1);

    if ((($a = (typeof(Math.log2) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.log2 = function(x) {
        return Math.log(x) / Math.LN2;
      }
    
    };

    Opal.defn(self, '$log2', TMP_24 = function $$log2(x) {
      var $a, self = this;

      if ((($a = $scope.get('String')['$==='](x)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('Opal').$type_error(x, $scope.get('Float')))};
      return $scope.get('Math').$checked("log2", $scope.get('Math')['$float!'](x));
    }, TMP_24.$$arity = 1);

    Opal.defn(self, '$sin', TMP_25 = function $$sin(x) {
      var self = this;

      return $scope.get('Math').$checked("sin", $scope.get('Math')['$float!'](x));
    }, TMP_25.$$arity = 1);

    if ((($a = (typeof(Math.sinh) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.sinh = function(x) {
        return (Math.exp(x) - Math.exp(-x)) / 2;
      }
    
    };

    Opal.defn(self, '$sinh', TMP_26 = function $$sinh(x) {
      var self = this;

      return $scope.get('Math').$checked("sinh", $scope.get('Math')['$float!'](x));
    }, TMP_26.$$arity = 1);

    Opal.defn(self, '$sqrt', TMP_27 = function $$sqrt(x) {
      var self = this;

      return $scope.get('Math').$checked("sqrt", $scope.get('Math')['$float!'](x));
    }, TMP_27.$$arity = 1);

    Opal.defn(self, '$tan', TMP_28 = function $$tan(x) {
      var $a, self = this;

      x = $scope.get('Math')['$float!'](x);
      if ((($a = x['$infinite?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return (($scope.get('Float')).$$scope.get('NAN'))};
      return $scope.get('Math').$checked("tan", $scope.get('Math')['$float!'](x));
    }, TMP_28.$$arity = 1);

    if ((($a = (typeof(Math.tanh) !== "undefined")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
      } else {
      
      Math.tanh = function(x) {
        if (x == Infinity) {
          return 1;
        }
        else if (x == -Infinity) {
          return -1;
        }
        else {
          return (Math.exp(x) - Math.exp(-x)) / (Math.exp(x) + Math.exp(-x));
        }
      }
    
    };

    Opal.defn(self, '$tanh', TMP_29 = function $$tanh(x) {
      var self = this;

      return $scope.get('Math').$checked("tanh", $scope.get('Math')['$float!'](x));
    }, TMP_29.$$arity = 1);
  })($scope.base)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/complex"] = function(Opal) {
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module;

  Opal.add_stubs(['$require', '$===', '$real?', '$raise', '$new', '$*', '$cos', '$sin', '$attr_reader', '$class', '$==', '$real', '$imag', '$Complex', '$-@', '$+', '$__coerced__', '$-', '$nan?', '$/', '$conj', '$abs2', '$quo', '$polar', '$exp', '$log', '$>', '$!=', '$divmod', '$**', '$hypot', '$atan2', '$lcm', '$denominator', '$to_s', '$numerator', '$abs', '$arg', '$rationalize', '$to_f', '$to_i', '$to_r', '$inspect', '$positive?', '$infinite?']);
  self.$require("corelib/numeric");
  (function($base, $super) {
    function $Complex(){};
    var self = $Complex = $klass($base, $super, 'Complex', $Complex);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29;

    def.real = def.imag = nil;
    Opal.defs(self, '$rect', TMP_1 = function $$rect(real, imag) {
      var $a, $b, $c, $d, self = this;

      if (imag == null) {
        imag = 0;
      }
      if ((($a = ($b = ($c = ($d = $scope.get('Numeric')['$==='](real), $d !== false && $d !== nil && $d != null ?real['$real?']() : $d), $c !== false && $c !== nil && $c != null ?$scope.get('Numeric')['$==='](imag) : $c), $b !== false && $b !== nil && $b != null ?imag['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not a real")
      };
      return self.$new(real, imag);
    }, TMP_1.$$arity = -2);

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      return Opal.alias(self, 'rectangular', 'rect')
    })(Opal.get_singleton_class(self));

    Opal.defs(self, '$polar', TMP_2 = function $$polar(r, theta) {
      var $a, $b, $c, $d, self = this;

      if (theta == null) {
        theta = 0;
      }
      if ((($a = ($b = ($c = ($d = $scope.get('Numeric')['$==='](r), $d !== false && $d !== nil && $d != null ?r['$real?']() : $d), $c !== false && $c !== nil && $c != null ?$scope.get('Numeric')['$==='](theta) : $c), $b !== false && $b !== nil && $b != null ?theta['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not a real")
      };
      return self.$new($rb_times(r, $scope.get('Math').$cos(theta)), $rb_times(r, $scope.get('Math').$sin(theta)));
    }, TMP_2.$$arity = -2);

    self.$attr_reader("real", "imag");

    Opal.defn(self, '$initialize', TMP_3 = function $$initialize(real, imag) {
      var self = this;

      if (imag == null) {
        imag = 0;
      }
      self.real = real;
      return self.imag = imag;
    }, TMP_3.$$arity = -2);

    Opal.defn(self, '$coerce', TMP_4 = function $$coerce(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return [other, self]
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](other), $b !== false && $b !== nil && $b != null ?other['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return [$scope.get('Complex').$new(other, 0), self]
        } else {
        return self.$raise($scope.get('TypeError'), "" + (other.$class()) + " can't be coerced into Complex")
      };
    }, TMP_4.$$arity = 1);

    Opal.defn(self, '$==', TMP_5 = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return (($a = self.real['$=='](other.$real())) ? self.imag['$=='](other.$imag()) : self.real['$=='](other.$real()))
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](other), $b !== false && $b !== nil && $b != null ?other['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return (($a = self.real['$=='](other)) ? self.imag['$=='](0) : self.real['$=='](other))
        } else {
        return other['$=='](self)
      };
    }, TMP_5.$$arity = 1);

    Opal.defn(self, '$-@', TMP_6 = function() {
      var self = this;

      return self.$Complex(self.real['$-@'](), self.imag['$-@']());
    }, TMP_6.$$arity = 0);

    Opal.defn(self, '$+', TMP_7 = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex($rb_plus(self.real, other.$real()), $rb_plus(self.imag, other.$imag()))
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](other), $b !== false && $b !== nil && $b != null ?other['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex($rb_plus(self.real, other), self.imag)
        } else {
        return self.$__coerced__("+", other)
      };
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$-', TMP_8 = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex($rb_minus(self.real, other.$real()), $rb_minus(self.imag, other.$imag()))
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](other), $b !== false && $b !== nil && $b != null ?other['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex($rb_minus(self.real, other), self.imag)
        } else {
        return self.$__coerced__("-", other)
      };
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$*', TMP_9 = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex($rb_minus($rb_times(self.real, other.$real()), $rb_times(self.imag, other.$imag())), $rb_plus($rb_times(self.real, other.$imag()), $rb_times(self.imag, other.$real())))
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](other), $b !== false && $b !== nil && $b != null ?other['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex($rb_times(self.real, other), $rb_times(self.imag, other))
        } else {
        return self.$__coerced__("*", other)
      };
    }, TMP_9.$$arity = 1);

    Opal.defn(self, '$/', TMP_10 = function(other) {
      var $a, $b, $c, $d, $e, self = this;

      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = ((($b = ((($c = ((($d = (($e = $scope.get('Number')['$==='](self.real), $e !== false && $e !== nil && $e != null ?self.real['$nan?']() : $e))) !== false && $d !== nil && $d != null) ? $d : (($e = $scope.get('Number')['$==='](self.imag), $e !== false && $e !== nil && $e != null ?self.imag['$nan?']() : $e)))) !== false && $c !== nil && $c != null) ? $c : (($d = $scope.get('Number')['$==='](other.$real()), $d !== false && $d !== nil && $d != null ?other.$real()['$nan?']() : $d)))) !== false && $b !== nil && $b != null) ? $b : (($c = $scope.get('Number')['$==='](other.$imag()), $c !== false && $c !== nil && $c != null ?other.$imag()['$nan?']() : $c)))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return $scope.get('Complex').$new((($scope.get('Float')).$$scope.get('NAN')), (($scope.get('Float')).$$scope.get('NAN')))
          } else {
          return $rb_divide($rb_times(self, other.$conj()), other.$abs2())
        }
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](other), $b !== false && $b !== nil && $b != null ?other['$real?']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Complex(self.real.$quo(other), self.imag.$quo(other))
        } else {
        return self.$__coerced__("/", other)
      };
    }, TMP_10.$$arity = 1);

    Opal.defn(self, '$**', TMP_11 = function(other) {
      var $a, $b, $c, $d, $e, self = this, r = nil, theta = nil, ore = nil, oim = nil, nr = nil, ntheta = nil, x = nil, z = nil, n = nil, div = nil, mod = nil;

      if (other['$=='](0)) {
        return $scope.get('Complex').$new(1, 0)};
      if ((($a = $scope.get('Complex')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        $b = self.$polar(), $a = Opal.to_ary($b), r = ($a[0] == null ? nil : $a[0]), theta = ($a[1] == null ? nil : $a[1]), $b;
        ore = other.$real();
        oim = other.$imag();
        nr = $scope.get('Math').$exp($rb_minus($rb_times(ore, $scope.get('Math').$log(r)), $rb_times(oim, theta)));
        ntheta = $rb_plus($rb_times(theta, ore), $rb_times(oim, $scope.get('Math').$log(r)));
        return $scope.get('Complex').$polar(nr, ntheta);
      } else if ((($a = $scope.get('Integer')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $rb_gt(other, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          x = self;
          z = x;
          n = $rb_minus(other, 1);
          while ((($b = n['$!='](0)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          while ((($c = ($e = n.$divmod(2), $d = Opal.to_ary($e), div = ($d[0] == null ? nil : $d[0]), mod = ($d[1] == null ? nil : $d[1]), $e, mod['$=='](0))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
          x = self.$Complex($rb_minus($rb_times(x.$real(), x.$real()), $rb_times(x.$imag(), x.$imag())), $rb_times($rb_times(2, x.$real()), x.$imag()));
          n = div;};
          z = $rb_times(z, x);
          n = $rb_minus(n, 1);};
          return z;
          } else {
          return ($rb_divide($scope.get('Rational').$new(1, 1), self))['$**'](other['$-@']())
        }
      } else if ((($a = ((($b = $scope.get('Float')['$==='](other)) !== false && $b !== nil && $b != null) ? $b : $scope.get('Rational')['$==='](other))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        $b = self.$polar(), $a = Opal.to_ary($b), r = ($a[0] == null ? nil : $a[0]), theta = ($a[1] == null ? nil : $a[1]), $b;
        return $scope.get('Complex').$polar(r['$**'](other), $rb_times(theta, other));
        } else {
        return self.$__coerced__("**", other)
      };
    }, TMP_11.$$arity = 1);

    Opal.defn(self, '$abs', TMP_12 = function $$abs() {
      var self = this;

      return $scope.get('Math').$hypot(self.real, self.imag);
    }, TMP_12.$$arity = 0);

    Opal.defn(self, '$abs2', TMP_13 = function $$abs2() {
      var self = this;

      return $rb_plus($rb_times(self.real, self.real), $rb_times(self.imag, self.imag));
    }, TMP_13.$$arity = 0);

    Opal.defn(self, '$angle', TMP_14 = function $$angle() {
      var self = this;

      return $scope.get('Math').$atan2(self.imag, self.real);
    }, TMP_14.$$arity = 0);

    Opal.alias(self, 'arg', 'angle');

    Opal.defn(self, '$conj', TMP_15 = function $$conj() {
      var self = this;

      return self.$Complex(self.real, self.imag['$-@']());
    }, TMP_15.$$arity = 0);

    Opal.alias(self, 'conjugate', 'conj');

    Opal.defn(self, '$denominator', TMP_16 = function $$denominator() {
      var self = this;

      return self.real.$denominator().$lcm(self.imag.$denominator());
    }, TMP_16.$$arity = 0);

    Opal.alias(self, 'divide', '/');

    Opal.defn(self, '$eql?', TMP_17 = function(other) {
      var $a, $b, self = this;

      return ($a = ($b = $scope.get('Complex')['$==='](other), $b !== false && $b !== nil && $b != null ?self.real.$class()['$=='](self.imag.$class()) : $b), $a !== false && $a !== nil && $a != null ?self['$=='](other) : $a);
    }, TMP_17.$$arity = 1);

    Opal.defn(self, '$fdiv', TMP_18 = function $$fdiv(other) {
      var $a, self = this;

      if ((($a = $scope.get('Numeric')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "" + (other.$class()) + " can't be coerced into Complex")
      };
      return $rb_divide(self, other);
    }, TMP_18.$$arity = 1);

    Opal.defn(self, '$hash', TMP_19 = function $$hash() {
      var self = this;

      return "Complex:" + (self.real) + ":" + (self.imag);
    }, TMP_19.$$arity = 0);

    Opal.alias(self, 'imaginary', 'imag');

    Opal.defn(self, '$inspect', TMP_20 = function $$inspect() {
      var self = this;

      return "(" + (self.$to_s()) + ")";
    }, TMP_20.$$arity = 0);

    Opal.alias(self, 'magnitude', 'abs');

    Opal.defn(self, '$numerator', TMP_21 = function $$numerator() {
      var self = this, d = nil;

      d = self.$denominator();
      return self.$Complex($rb_times(self.real.$numerator(), ($rb_divide(d, self.real.$denominator()))), $rb_times(self.imag.$numerator(), ($rb_divide(d, self.imag.$denominator()))));
    }, TMP_21.$$arity = 0);

    Opal.alias(self, 'phase', 'arg');

    Opal.defn(self, '$polar', TMP_22 = function $$polar() {
      var self = this;

      return [self.$abs(), self.$arg()];
    }, TMP_22.$$arity = 0);

    Opal.alias(self, 'quo', '/');

    Opal.defn(self, '$rationalize', TMP_23 = function $$rationalize(eps) {
      var $a, self = this;

      
      if (arguments.length > 1) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..1)");
      }
    ;
      if ((($a = self.imag['$!='](0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('RangeError'), "can't' convert " + (self) + " into Rational")};
      return self.$real().$rationalize(eps);
    }, TMP_23.$$arity = -1);

    Opal.defn(self, '$real?', TMP_24 = function() {
      var self = this;

      return false;
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$rect', TMP_25 = function $$rect() {
      var self = this;

      return [self.real, self.imag];
    }, TMP_25.$$arity = 0);

    Opal.alias(self, 'rectangular', 'rect');

    Opal.defn(self, '$to_f', TMP_26 = function $$to_f() {
      var self = this;

      if (self.imag['$=='](0)) {
        } else {
        self.$raise($scope.get('RangeError'), "can't convert " + (self) + " into Float")
      };
      return self.real.$to_f();
    }, TMP_26.$$arity = 0);

    Opal.defn(self, '$to_i', TMP_27 = function $$to_i() {
      var self = this;

      if (self.imag['$=='](0)) {
        } else {
        self.$raise($scope.get('RangeError'), "can't convert " + (self) + " into Integer")
      };
      return self.real.$to_i();
    }, TMP_27.$$arity = 0);

    Opal.defn(self, '$to_r', TMP_28 = function $$to_r() {
      var self = this;

      if (self.imag['$=='](0)) {
        } else {
        self.$raise($scope.get('RangeError'), "can't convert " + (self) + " into Rational")
      };
      return self.real.$to_r();
    }, TMP_28.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_29 = function $$to_s() {
      var $a, $b, $c, self = this, result = nil;

      result = self.real.$inspect();
      if ((($a = ((($b = (($c = $scope.get('Number')['$==='](self.imag), $c !== false && $c !== nil && $c != null ?self.imag['$nan?']() : $c))) !== false && $b !== nil && $b != null) ? $b : self.imag['$positive?']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        result = $rb_plus(result, "+")
        } else {
        result = $rb_plus(result, "-")
      };
      result = $rb_plus(result, self.imag.$abs().$inspect());
      if ((($a = ($b = $scope.get('Number')['$==='](self.imag), $b !== false && $b !== nil && $b != null ?(((($c = self.imag['$nan?']()) !== false && $c !== nil && $c != null) ? $c : self.imag['$infinite?']())) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        result = $rb_plus(result, "*")};
      return $rb_plus(result, "i");
    }, TMP_29.$$arity = 0);

    return Opal.cdecl($scope, 'I', self.$new(0, 1));
  })($scope.base, $scope.get('Numeric'));
  return (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_30;

    Opal.defn(self, '$Complex', TMP_30 = function $$Complex(real, imag) {
      var self = this;

      if (imag == null) {
        imag = nil;
      }
      if (imag !== false && imag !== nil && imag != null) {
        return $scope.get('Complex').$new(real, imag)
        } else {
        return $scope.get('Complex').$new(real, 0)
      };
    }, TMP_30.$$arity = -2)
  })($scope.base);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/rational"] = function(Opal) {
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module;

  Opal.add_stubs(['$require', '$to_i', '$==', '$raise', '$<', '$-@', '$new', '$gcd', '$/', '$nil?', '$===', '$reduce', '$to_r', '$equal?', '$!', '$coerce_to!', '$attr_reader', '$to_f', '$numerator', '$denominator', '$<=>', '$-', '$*', '$__coerced__', '$+', '$Rational', '$>', '$**', '$abs', '$ceil', '$with_precision', '$floor', '$to_s', '$<=', '$truncate', '$send', '$convert']);
  self.$require("corelib/numeric");
  (function($base, $super) {
    function $Rational(){};
    var self = $Rational = $klass($base, $super, 'Rational', $Rational);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26;

    def.num = def.den = nil;
    Opal.defs(self, '$reduce', TMP_1 = function $$reduce(num, den) {
      var $a, self = this, gcd = nil;

      num = num.$to_i();
      den = den.$to_i();
      if (den['$=='](0)) {
        self.$raise($scope.get('ZeroDivisionError'), "divided by 0")
      } else if ((($a = $rb_lt(den, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        num = num['$-@']();
        den = den['$-@']();
      } else if (den['$=='](1)) {
        return self.$new(num, den)};
      gcd = num.$gcd(den);
      return self.$new($rb_divide(num, gcd), $rb_divide(den, gcd));
    }, TMP_1.$$arity = 2);

    Opal.defs(self, '$convert', TMP_2 = function $$convert(num, den) {
      var $a, $b, $c, self = this;

      if ((($a = ((($b = num['$nil?']()) !== false && $b !== nil && $b != null) ? $b : den['$nil?']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "cannot convert nil into Rational")};
      if ((($a = ($b = $scope.get('Integer')['$==='](num), $b !== false && $b !== nil && $b != null ?$scope.get('Integer')['$==='](den) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$reduce(num, den)};
      if ((($a = ((($b = ((($c = $scope.get('Float')['$==='](num)) !== false && $c !== nil && $c != null) ? $c : $scope.get('String')['$==='](num))) !== false && $b !== nil && $b != null) ? $b : $scope.get('Complex')['$==='](num))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        num = num.$to_r()};
      if ((($a = ((($b = ((($c = $scope.get('Float')['$==='](den)) !== false && $c !== nil && $c != null) ? $c : $scope.get('String')['$==='](den))) !== false && $b !== nil && $b != null) ? $b : $scope.get('Complex')['$==='](den))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        den = den.$to_r()};
      if ((($a = ($b = den['$equal?'](1), $b !== false && $b !== nil && $b != null ?($scope.get('Integer')['$==='](num))['$!']() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('Opal')['$coerce_to!'](num, $scope.get('Rational'), "to_r")
      } else if ((($a = ($b = $scope.get('Numeric')['$==='](num), $b !== false && $b !== nil && $b != null ?$scope.get('Numeric')['$==='](den) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $rb_divide(num, den)
        } else {
        return self.$reduce(num, den)
      };
    }, TMP_2.$$arity = 2);

    self.$attr_reader("numerator", "denominator");

    Opal.defn(self, '$initialize', TMP_3 = function $$initialize(num, den) {
      var self = this;

      self.num = num;
      return self.den = den;
    }, TMP_3.$$arity = 2);

    Opal.defn(self, '$numerator', TMP_4 = function $$numerator() {
      var self = this;

      return self.num;
    }, TMP_4.$$arity = 0);

    Opal.defn(self, '$denominator', TMP_5 = function $$denominator() {
      var self = this;

      return self.den;
    }, TMP_5.$$arity = 0);

    Opal.defn(self, '$coerce', TMP_6 = function $$coerce(other) {
      var self = this, $case = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {return [other, self]}else if ($scope.get('Integer')['$===']($case)) {return [other.$to_r(), self]}else if ($scope.get('Float')['$===']($case)) {return [other, self.$to_f()]}else { return nil }})();
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$==', TMP_7 = function(other) {
      var $a, self = this, $case = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {return (($a = self.num['$=='](other.$numerator())) ? self.den['$=='](other.$denominator()) : self.num['$=='](other.$numerator()))}else if ($scope.get('Integer')['$===']($case)) {return (($a = self.num['$=='](other)) ? self.den['$=='](1) : self.num['$=='](other))}else if ($scope.get('Float')['$===']($case)) {return self.$to_f()['$=='](other)}else {return other['$=='](self)}})();
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$<=>', TMP_8 = function(other) {
      var self = this, $case = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {return $rb_minus($rb_times(self.num, other.$denominator()), $rb_times(self.den, other.$numerator()))['$<=>'](0)}else if ($scope.get('Integer')['$===']($case)) {return $rb_minus(self.num, $rb_times(self.den, other))['$<=>'](0)}else if ($scope.get('Float')['$===']($case)) {return self.$to_f()['$<=>'](other)}else {return self.$__coerced__("<=>", other)}})();
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$+', TMP_9 = function(other) {
      var self = this, $case = nil, num = nil, den = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {num = $rb_plus($rb_times(self.num, other.$denominator()), $rb_times(self.den, other.$numerator()));
      den = $rb_times(self.den, other.$denominator());
      return self.$Rational(num, den);}else if ($scope.get('Integer')['$===']($case)) {return self.$Rational($rb_plus(self.num, $rb_times(other, self.den)), self.den)}else if ($scope.get('Float')['$===']($case)) {return $rb_plus(self.$to_f(), other)}else {return self.$__coerced__("+", other)}})();
    }, TMP_9.$$arity = 1);

    Opal.defn(self, '$-', TMP_10 = function(other) {
      var self = this, $case = nil, num = nil, den = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {num = $rb_minus($rb_times(self.num, other.$denominator()), $rb_times(self.den, other.$numerator()));
      den = $rb_times(self.den, other.$denominator());
      return self.$Rational(num, den);}else if ($scope.get('Integer')['$===']($case)) {return self.$Rational($rb_minus(self.num, $rb_times(other, self.den)), self.den)}else if ($scope.get('Float')['$===']($case)) {return $rb_minus(self.$to_f(), other)}else {return self.$__coerced__("-", other)}})();
    }, TMP_10.$$arity = 1);

    Opal.defn(self, '$*', TMP_11 = function(other) {
      var self = this, $case = nil, num = nil, den = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {num = $rb_times(self.num, other.$numerator());
      den = $rb_times(self.den, other.$denominator());
      return self.$Rational(num, den);}else if ($scope.get('Integer')['$===']($case)) {return self.$Rational($rb_times(self.num, other), self.den)}else if ($scope.get('Float')['$===']($case)) {return $rb_times(self.$to_f(), other)}else {return self.$__coerced__("*", other)}})();
    }, TMP_11.$$arity = 1);

    Opal.defn(self, '$/', TMP_12 = function(other) {
      var self = this, $case = nil, num = nil, den = nil;

      return (function() {$case = other;if ($scope.get('Rational')['$===']($case)) {num = $rb_times(self.num, other.$denominator());
      den = $rb_times(self.den, other.$numerator());
      return self.$Rational(num, den);}else if ($scope.get('Integer')['$===']($case)) {if (other['$=='](0)) {
        return $rb_divide(self.$to_f(), 0.0)
        } else {
        return self.$Rational(self.num, $rb_times(self.den, other))
      }}else if ($scope.get('Float')['$===']($case)) {return $rb_divide(self.$to_f(), other)}else {return self.$__coerced__("/", other)}})();
    }, TMP_12.$$arity = 1);

    Opal.defn(self, '$**', TMP_13 = function(other) {
      var $a, $b, self = this, $case = nil;

      return (function() {$case = other;if ($scope.get('Integer')['$===']($case)) {if ((($a = (($b = self['$=='](0)) ? $rb_lt(other, 0) : self['$=='](0))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return (($scope.get('Float')).$$scope.get('INFINITY'))
      } else if ((($a = $rb_gt(other, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Rational(self.num['$**'](other), self.den['$**'](other))
      } else if ((($a = $rb_lt(other, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$Rational(self.den['$**'](other['$-@']()), self.num['$**'](other['$-@']()))
        } else {
        return self.$Rational(1, 1)
      }}else if ($scope.get('Float')['$===']($case)) {return self.$to_f()['$**'](other)}else if ($scope.get('Rational')['$===']($case)) {if (other['$=='](0)) {
        return self.$Rational(1, 1)
      } else if (other.$denominator()['$=='](1)) {
        if ((($a = $rb_lt(other, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.$Rational(self.den['$**'](other.$numerator().$abs()), self.num['$**'](other.$numerator().$abs()))
          } else {
          return self.$Rational(self.num['$**'](other.$numerator()), self.den['$**'](other.$numerator()))
        }
      } else if ((($a = (($b = self['$=='](0)) ? $rb_lt(other, 0) : self['$=='](0))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('ZeroDivisionError'), "divided by 0")
        } else {
        return self.$to_f()['$**'](other)
      }}else {return self.$__coerced__("**", other)}})();
    }, TMP_13.$$arity = 1);

    Opal.defn(self, '$abs', TMP_14 = function $$abs() {
      var self = this;

      return self.$Rational(self.num.$abs(), self.den.$abs());
    }, TMP_14.$$arity = 0);

    Opal.defn(self, '$ceil', TMP_15 = function $$ceil(precision) {
      var self = this;

      if (precision == null) {
        precision = 0;
      }
      if (precision['$=='](0)) {
        return (($rb_divide(self.num['$-@'](), self.den))['$-@']()).$ceil()
        } else {
        return self.$with_precision("ceil", precision)
      };
    }, TMP_15.$$arity = -1);

    Opal.alias(self, 'divide', '/');

    Opal.defn(self, '$floor', TMP_16 = function $$floor(precision) {
      var self = this;

      if (precision == null) {
        precision = 0;
      }
      if (precision['$=='](0)) {
        return (($rb_divide(self.num['$-@'](), self.den))['$-@']()).$floor()
        } else {
        return self.$with_precision("floor", precision)
      };
    }, TMP_16.$$arity = -1);

    Opal.defn(self, '$hash', TMP_17 = function $$hash() {
      var self = this;

      return "Rational:" + (self.num) + ":" + (self.den);
    }, TMP_17.$$arity = 0);

    Opal.defn(self, '$inspect', TMP_18 = function $$inspect() {
      var self = this;

      return "(" + (self.$to_s()) + ")";
    }, TMP_18.$$arity = 0);

    Opal.alias(self, 'quo', '/');

    Opal.defn(self, '$rationalize', TMP_19 = function $$rationalize(eps) {
      var self = this;

      
      if (arguments.length > 1) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..1)");
      }

      if (eps == null) {
        return self;
      }

      var e = eps.$abs(),
          a = $rb_minus(self, e),
          b = $rb_plus(self, e);

      var p0 = 0,
          p1 = 1,
          q0 = 1,
          q1 = 0,
          p2, q2;

      var c, k, t;

      while (true) {
        c = (a).$ceil();

        if ($rb_le(c, b)) {
          break;
        }

        k  = c - 1;
        p2 = k * p1 + p0;
        q2 = k * q1 + q0;
        t  = $rb_divide(1, ($rb_minus(b, k)));
        b  = $rb_divide(1, ($rb_minus(a, k)));
        a  = t;

        p0 = p1;
        q0 = q1;
        p1 = p2;
        q1 = q2;
      }

      return self.$Rational(c * p1 + p0, c * q1 + q0);
    ;
    }, TMP_19.$$arity = -1);

    Opal.defn(self, '$round', TMP_20 = function $$round(precision) {
      var $a, self = this, num = nil, den = nil, approx = nil;

      if (precision == null) {
        precision = 0;
      }
      if (precision['$=='](0)) {
        } else {
        return self.$with_precision("round", precision)
      };
      if (self.num['$=='](0)) {
        return 0};
      if (self.den['$=='](1)) {
        return self.num};
      num = $rb_plus($rb_times(self.num.$abs(), 2), self.den);
      den = $rb_times(self.den, 2);
      approx = ($rb_divide(num, den)).$truncate();
      if ((($a = $rb_lt(self.num, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return approx['$-@']()
        } else {
        return approx
      };
    }, TMP_20.$$arity = -1);

    Opal.defn(self, '$to_f', TMP_21 = function $$to_f() {
      var self = this;

      return $rb_divide(self.num, self.den);
    }, TMP_21.$$arity = 0);

    Opal.defn(self, '$to_i', TMP_22 = function $$to_i() {
      var self = this;

      return self.$truncate();
    }, TMP_22.$$arity = 0);

    Opal.defn(self, '$to_r', TMP_23 = function $$to_r() {
      var self = this;

      return self;
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$to_s', TMP_24 = function $$to_s() {
      var self = this;

      return "" + (self.num) + "/" + (self.den);
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$truncate', TMP_25 = function $$truncate(precision) {
      var $a, self = this;

      if (precision == null) {
        precision = 0;
      }
      if (precision['$=='](0)) {
        if ((($a = $rb_lt(self.num, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.$ceil()
          } else {
          return self.$floor()
        }
        } else {
        return self.$with_precision("truncate", precision)
      };
    }, TMP_25.$$arity = -1);

    return (Opal.defn(self, '$with_precision', TMP_26 = function $$with_precision(method, precision) {
      var $a, self = this, p = nil, s = nil;

      if ((($a = $scope.get('Integer')['$==='](precision)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an Integer")
      };
      p = (10)['$**'](precision);
      s = $rb_times(self, p);
      if ((($a = $rb_lt(precision, 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return ($rb_divide(s.$send(method), p)).$to_i()
        } else {
        return self.$Rational(s.$send(method), p)
      };
    }, TMP_26.$$arity = 2), nil) && 'with_precision';
  })($scope.base, $scope.get('Numeric'));
  return (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_27;

    Opal.defn(self, '$Rational', TMP_27 = function $$Rational(numerator, denominator) {
      var self = this;

      if (denominator == null) {
        denominator = 1;
      }
      return $scope.get('Rational').$convert(numerator, denominator);
    }, TMP_27.$$arity = -2)
  })($scope.base);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/time"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$require', '$include', '$===', '$raise', '$coerce_to!', '$respond_to?', '$to_str', '$to_i', '$new', '$<=>', '$to_f', '$nil?', '$>', '$<', '$strftime', '$year', '$month', '$day', '$+', '$round', '$/', '$-', '$copy_instance_variables', '$initialize_dup', '$is_a?', '$zero?', '$wday', '$utc?', '$mon', '$yday', '$hour', '$min', '$sec', '$rjust', '$ljust', '$zone', '$to_s', '$[]', '$cweek_cyear', '$isdst', '$<=', '$!=', '$==', '$ceil']);
  self.$require("corelib/comparable");
  return (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_34, TMP_35, TMP_36, TMP_37, TMP_38, TMP_39, TMP_40, TMP_41, TMP_42;

    self.$include($scope.get('Comparable'));

    
    var days_of_week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short_days   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        short_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        long_months  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  ;

    Opal.defs(self, '$at', TMP_1 = function $$at(seconds, frac) {
      var self = this;

      
      var result;

      if ($scope.get('Time')['$==='](seconds)) {
        if (frac !== undefined) {
          self.$raise($scope.get('TypeError'), "can't convert Time into an exact number")
        }
        result = new Date(seconds.getTime());
        result.is_utc = seconds.is_utc;
        return result;
      }

      if (!seconds.$$is_number) {
        seconds = $scope.get('Opal')['$coerce_to!'](seconds, $scope.get('Integer'), "to_int");
      }

      if (frac === undefined) {
        return new Date(seconds * 1000);
      }

      if (!frac.$$is_number) {
        frac = $scope.get('Opal')['$coerce_to!'](frac, $scope.get('Integer'), "to_int");
      }

      return new Date(seconds * 1000 + (frac / 1000));
    ;
    }, TMP_1.$$arity = -2);

    
    function time_params(year, month, day, hour, min, sec) {
      if (year.$$is_string) {
        year = parseInt(year, 10);
      } else {
        year = $scope.get('Opal')['$coerce_to!'](year, $scope.get('Integer'), "to_int");
      }

      if (month === nil) {
        month = 1;
      } else if (!month.$$is_number) {
        if ((month)['$respond_to?']("to_str")) {
          month = (month).$to_str();
          switch (month.toLowerCase()) {
          case 'jan': month =  1; break;
          case 'feb': month =  2; break;
          case 'mar': month =  3; break;
          case 'apr': month =  4; break;
          case 'may': month =  5; break;
          case 'jun': month =  6; break;
          case 'jul': month =  7; break;
          case 'aug': month =  8; break;
          case 'sep': month =  9; break;
          case 'oct': month = 10; break;
          case 'nov': month = 11; break;
          case 'dec': month = 12; break;
          default: month = (month).$to_i();
          }
        } else {
          month = $scope.get('Opal')['$coerce_to!'](month, $scope.get('Integer'), "to_int");
        }
      }

      if (month < 1 || month > 12) {
        self.$raise($scope.get('ArgumentError'), "month out of range: " + (month))
      }
      month = month - 1;

      if (day === nil) {
        day = 1;
      } else if (day.$$is_string) {
        day = parseInt(day, 10);
      } else {
        day = $scope.get('Opal')['$coerce_to!'](day, $scope.get('Integer'), "to_int");
      }

      if (day < 1 || day > 31) {
        self.$raise($scope.get('ArgumentError'), "day out of range: " + (day))
      }

      if (hour === nil) {
        hour = 0;
      } else if (hour.$$is_string) {
        hour = parseInt(hour, 10);
      } else {
        hour = $scope.get('Opal')['$coerce_to!'](hour, $scope.get('Integer'), "to_int");
      }

      if (hour < 0 || hour > 24) {
        self.$raise($scope.get('ArgumentError'), "hour out of range: " + (hour))
      }

      if (min === nil) {
        min = 0;
      } else if (min.$$is_string) {
        min = parseInt(min, 10);
      } else {
        min = $scope.get('Opal')['$coerce_to!'](min, $scope.get('Integer'), "to_int");
      }

      if (min < 0 || min > 59) {
        self.$raise($scope.get('ArgumentError'), "min out of range: " + (min))
      }

      if (sec === nil) {
        sec = 0;
      } else if (!sec.$$is_number) {
        if (sec.$$is_string) {
          sec = parseInt(sec, 10);
        } else {
          sec = $scope.get('Opal')['$coerce_to!'](sec, $scope.get('Integer'), "to_int");
        }
      }

      if (sec < 0 || sec > 60) {
        self.$raise($scope.get('ArgumentError'), "sec out of range: " + (sec))
      }

      return [year, month, day, hour, min, sec];
    }
  ;

    Opal.defs(self, '$new', TMP_2 = function(year, month, day, hour, min, sec, utc_offset) {
      var self = this;

      if (month == null) {
        month = nil;
      }
      if (day == null) {
        day = nil;
      }
      if (hour == null) {
        hour = nil;
      }
      if (min == null) {
        min = nil;
      }
      if (sec == null) {
        sec = nil;
      }
      if (utc_offset == null) {
        utc_offset = nil;
      }
      
      var args, result;

      if (year === undefined) {
        return new Date();
      }

      if (utc_offset !== nil) {
        self.$raise($scope.get('ArgumentError'), "Opal does not support explicitly specifying UTC offset for Time")
      }

      args  = time_params(year, month, day, hour, min, sec);
      year  = args[0];
      month = args[1];
      day   = args[2];
      hour  = args[3];
      min   = args[4];
      sec   = args[5];

      result = new Date(year, month, day, hour, min, 0, sec * 1000);
      if (year < 100) {
        result.setFullYear(year);
      }
      return result;
    
    }, TMP_2.$$arity = -1);

    Opal.defs(self, '$local', TMP_3 = function $$local(year, month, day, hour, min, sec, millisecond, _dummy1, _dummy2, _dummy3) {
      var self = this;

      if (month == null) {
        month = nil;
      }
      if (day == null) {
        day = nil;
      }
      if (hour == null) {
        hour = nil;
      }
      if (min == null) {
        min = nil;
      }
      if (sec == null) {
        sec = nil;
      }
      if (millisecond == null) {
        millisecond = nil;
      }
      if (_dummy1 == null) {
        _dummy1 = nil;
      }
      if (_dummy2 == null) {
        _dummy2 = nil;
      }
      if (_dummy3 == null) {
        _dummy3 = nil;
      }
      
      var args, result;

      if (arguments.length === 10) {
        args  = $slice.call(arguments);
        year  = args[5];
        month = args[4];
        day   = args[3];
        hour  = args[2];
        min   = args[1];
        sec   = args[0];
      }

      args  = time_params(year, month, day, hour, min, sec);
      year  = args[0];
      month = args[1];
      day   = args[2];
      hour  = args[3];
      min   = args[4];
      sec   = args[5];

      result = new Date(year, month, day, hour, min, 0, sec * 1000);
      if (year < 100) {
        result.setFullYear(year);
      }
      return result;
    
    }, TMP_3.$$arity = -2);

    Opal.defs(self, '$gm', TMP_4 = function $$gm(year, month, day, hour, min, sec, millisecond, _dummy1, _dummy2, _dummy3) {
      var self = this;

      if (month == null) {
        month = nil;
      }
      if (day == null) {
        day = nil;
      }
      if (hour == null) {
        hour = nil;
      }
      if (min == null) {
        min = nil;
      }
      if (sec == null) {
        sec = nil;
      }
      if (millisecond == null) {
        millisecond = nil;
      }
      if (_dummy1 == null) {
        _dummy1 = nil;
      }
      if (_dummy2 == null) {
        _dummy2 = nil;
      }
      if (_dummy3 == null) {
        _dummy3 = nil;
      }
      
      var args, result;

      if (arguments.length === 10) {
        args  = $slice.call(arguments);
        year  = args[5];
        month = args[4];
        day   = args[3];
        hour  = args[2];
        min   = args[1];
        sec   = args[0];
      }

      args  = time_params(year, month, day, hour, min, sec);
      year  = args[0];
      month = args[1];
      day   = args[2];
      hour  = args[3];
      min   = args[4];
      sec   = args[5];

      result = new Date(Date.UTC(year, month, day, hour, min, 0, sec * 1000));
      if (year < 100) {
        result.setUTCFullYear(year);
      }
      result.is_utc = true;
      return result;
    
    }, TMP_4.$$arity = -2);

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      Opal.alias(self, 'mktime', 'local');
      return Opal.alias(self, 'utc', 'gm');
    })(Opal.get_singleton_class(self));

    Opal.defs(self, '$now', TMP_5 = function $$now() {
      var self = this;

      return self.$new();
    }, TMP_5.$$arity = 0);

    Opal.defn(self, '$+', TMP_6 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "time + time?")};
      
      if (!other.$$is_number) {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Integer'), "to_int");
      }
      var result = new Date(self.getTime() + (other * 1000));
      result.is_utc = self.is_utc;
      return result;
    ;
    }, TMP_6.$$arity = 1);

    Opal.defn(self, '$-', TMP_7 = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return (self.getTime() - other.getTime()) / 1000};
      
      if (!other.$$is_number) {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Integer'), "to_int");
      }
      var result = new Date(self.getTime() - (other * 1000));
      result.is_utc = self.is_utc;
      return result;
    ;
    }, TMP_7.$$arity = 1);

    Opal.defn(self, '$<=>', TMP_8 = function(other) {
      var $a, self = this, r = nil;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$to_f()['$<=>'](other.$to_f())
        } else {
        r = other['$<=>'](self);
        if ((($a = r['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil
        } else if ((($a = $rb_gt(r, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return -1
        } else if ((($a = $rb_lt(r, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return 1
          } else {
          return 0
        };
      };
    }, TMP_8.$$arity = 1);

    Opal.defn(self, '$==', TMP_9 = function(other) {
      var self = this;

      return self.$to_f() === other.$to_f();
    }, TMP_9.$$arity = 1);

    Opal.defn(self, '$asctime', TMP_10 = function $$asctime() {
      var self = this;

      return self.$strftime("%a %b %e %H:%M:%S %Y");
    }, TMP_10.$$arity = 0);

    Opal.alias(self, 'ctime', 'asctime');

    Opal.defn(self, '$day', TMP_11 = function $$day() {
      var self = this;

      return self.is_utc ? self.getUTCDate() : self.getDate();
    }, TMP_11.$$arity = 0);

    Opal.defn(self, '$yday', TMP_12 = function $$yday() {
      var self = this, start_of_year = nil, start_of_day = nil, one_day = nil;

      start_of_year = $scope.get('Time').$new(self.$year()).$to_i();
      start_of_day = $scope.get('Time').$new(self.$year(), self.$month(), self.$day()).$to_i();
      one_day = 86400;
      return $rb_plus(($rb_divide(($rb_minus(start_of_day, start_of_year)), one_day)).$round(), 1);
    }, TMP_12.$$arity = 0);

    Opal.defn(self, '$isdst', TMP_13 = function $$isdst() {
      var self = this;

      
      var jan = new Date(self.getFullYear(), 0, 1),
          jul = new Date(self.getFullYear(), 6, 1);
      return self.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    
    }, TMP_13.$$arity = 0);

    Opal.alias(self, 'dst?', 'isdst');

    Opal.defn(self, '$dup', TMP_14 = function $$dup() {
      var self = this, copy = nil;

      copy = new Date(self.getTime());
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    }, TMP_14.$$arity = 0);

    Opal.defn(self, '$eql?', TMP_15 = function(other) {
      var $a, self = this;

      return ($a = other['$is_a?']($scope.get('Time')), $a !== false && $a !== nil && $a != null ?(self['$<=>'](other))['$zero?']() : $a);
    }, TMP_15.$$arity = 1);

    Opal.defn(self, '$friday?', TMP_16 = function() {
      var self = this;

      return self.$wday() == 5;
    }, TMP_16.$$arity = 0);

    Opal.defn(self, '$hash', TMP_17 = function $$hash() {
      var self = this;

      return 'Time:' + self.getTime();
    }, TMP_17.$$arity = 0);

    Opal.defn(self, '$hour', TMP_18 = function $$hour() {
      var self = this;

      return self.is_utc ? self.getUTCHours() : self.getHours();
    }, TMP_18.$$arity = 0);

    Opal.defn(self, '$inspect', TMP_19 = function $$inspect() {
      var $a, self = this;

      if ((($a = self['$utc?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return self.$strftime("%Y-%m-%d %H:%M:%S UTC")
        } else {
        return self.$strftime("%Y-%m-%d %H:%M:%S %z")
      };
    }, TMP_19.$$arity = 0);

    Opal.alias(self, 'mday', 'day');

    Opal.defn(self, '$min', TMP_20 = function $$min() {
      var self = this;

      return self.is_utc ? self.getUTCMinutes() : self.getMinutes();
    }, TMP_20.$$arity = 0);

    Opal.defn(self, '$mon', TMP_21 = function $$mon() {
      var self = this;

      return (self.is_utc ? self.getUTCMonth() : self.getMonth()) + 1;
    }, TMP_21.$$arity = 0);

    Opal.defn(self, '$monday?', TMP_22 = function() {
      var self = this;

      return self.$wday() == 1;
    }, TMP_22.$$arity = 0);

    Opal.alias(self, 'month', 'mon');

    Opal.defn(self, '$saturday?', TMP_23 = function() {
      var self = this;

      return self.$wday() == 6;
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$sec', TMP_24 = function $$sec() {
      var self = this;

      return self.is_utc ? self.getUTCSeconds() : self.getSeconds();
    }, TMP_24.$$arity = 0);

    Opal.defn(self, '$succ', TMP_25 = function $$succ() {
      var self = this;

      
      var result = new Date(self.getTime() + 1000);
      result.is_utc = self.is_utc;
      return result;
    
    }, TMP_25.$$arity = 0);

    Opal.defn(self, '$usec', TMP_26 = function $$usec() {
      var self = this;

      return self.getMilliseconds() * 1000;
    }, TMP_26.$$arity = 0);

    Opal.defn(self, '$zone', TMP_27 = function $$zone() {
      var self = this;

      
      var string = self.toString(),
          result;

      if (string.indexOf('(') == -1) {
        result = string.match(/[A-Z]{3,4}/)[0];
      }
      else {
        result = string.match(/\([^)]+\)/)[0].match(/[A-Z]/g).join('');
      }

      if (result == "GMT" && /(GMT\W*\d{4})/.test(string)) {
        return RegExp.$1;
      }
      else {
        return result;
      }
    
    }, TMP_27.$$arity = 0);

    Opal.defn(self, '$getgm', TMP_28 = function $$getgm() {
      var self = this;

      
      var result = new Date(self.getTime());
      result.is_utc = true;
      return result;
    
    }, TMP_28.$$arity = 0);

    Opal.alias(self, 'getutc', 'getgm');

    Opal.defn(self, '$gmtime', TMP_29 = function $$gmtime() {
      var self = this;

      
      self.is_utc = true;
      return self;
    
    }, TMP_29.$$arity = 0);

    Opal.alias(self, 'utc', 'gmtime');

    Opal.defn(self, '$gmt?', TMP_30 = function() {
      var self = this;

      return self.is_utc === true;
    }, TMP_30.$$arity = 0);

    Opal.defn(self, '$gmt_offset', TMP_31 = function $$gmt_offset() {
      var self = this;

      return -self.getTimezoneOffset() * 60;
    }, TMP_31.$$arity = 0);

    Opal.defn(self, '$strftime', TMP_32 = function $$strftime(format) {
      var self = this;

      
      return format.replace(/%([\-_#^0]*:{0,2})(\d+)?([EO]*)(.)/g, function(full, flags, width, _, conv) {
        var result = "",
            zero   = flags.indexOf('0') !== -1,
            pad    = flags.indexOf('-') === -1,
            blank  = flags.indexOf('_') !== -1,
            upcase = flags.indexOf('^') !== -1,
            invert = flags.indexOf('#') !== -1,
            colons = (flags.match(':') || []).length;

        width = parseInt(width, 10);

        if (zero && blank) {
          if (flags.indexOf('0') < flags.indexOf('_')) {
            zero = false;
          }
          else {
            blank = false;
          }
        }

        switch (conv) {
          case 'Y':
            result += self.$year();
            break;

          case 'C':
            zero    = !blank;
            result += Math.round(self.$year() / 100);
            break;

          case 'y':
            zero    = !blank;
            result += (self.$year() % 100);
            break;

          case 'm':
            zero    = !blank;
            result += self.$mon();
            break;

          case 'B':
            result += long_months[self.$mon() - 1];
            break;

          case 'b':
          case 'h':
            blank   = !zero;
            result += short_months[self.$mon() - 1];
            break;

          case 'd':
            zero    = !blank
            result += self.$day();
            break;

          case 'e':
            blank   = !zero
            result += self.$day();
            break;

          case 'j':
            result += self.$yday();
            break;

          case 'H':
            zero    = !blank;
            result += self.$hour();
            break;

          case 'k':
            blank   = !zero;
            result += self.$hour();
            break;

          case 'I':
            zero    = !blank;
            result += (self.$hour() % 12 || 12);
            break;

          case 'l':
            blank   = !zero;
            result += (self.$hour() % 12 || 12);
            break;

          case 'P':
            result += (self.$hour() >= 12 ? "pm" : "am");
            break;

          case 'p':
            result += (self.$hour() >= 12 ? "PM" : "AM");
            break;

          case 'M':
            zero    = !blank;
            result += self.$min();
            break;

          case 'S':
            zero    = !blank;
            result += self.$sec()
            break;

          case 'L':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.getMilliseconds();
            break;

          case 'N':
            width   = isNaN(width) ? 9 : width;
            result += (self.getMilliseconds().toString()).$rjust(3, "0");
            result  = (result).$ljust(width, "0");
            break;

          case 'z':
            var offset  = self.getTimezoneOffset(),
                hours   = Math.floor(Math.abs(offset) / 60),
                minutes = Math.abs(offset) % 60;

            result += offset < 0 ? "+" : "-";
            result += hours < 10 ? "0" : "";
            result += hours;

            if (colons > 0) {
              result += ":";
            }

            result += minutes < 10 ? "0" : "";
            result += minutes;

            if (colons > 1) {
              result += ":00";
            }

            break;

          case 'Z':
            result += self.$zone();
            break;

          case 'A':
            result += days_of_week[self.$wday()];
            break;

          case 'a':
            result += short_days[self.$wday()];
            break;

          case 'u':
            result += (self.$wday() + 1);
            break;

          case 'w':
            result += self.$wday();
            break;

          case 'V':
            result += self.$cweek_cyear()['$[]'](0).$to_s().$rjust(2, "0");
            break;

          case 'G':
            result += self.$cweek_cyear()['$[]'](1);
            break;

          case 'g':
            result += self.$cweek_cyear()['$[]'](1)['$[]']($range(-2, -1, false));
            break;

          case 's':
            result += self.$to_i();
            break;

          case 'n':
            result += "\n";
            break;

          case 't':
            result += "\t";
            break;

          case '%':
            result += "%";
            break;

          case 'c':
            result += self.$strftime("%a %b %e %T %Y");
            break;

          case 'D':
          case 'x':
            result += self.$strftime("%m/%d/%y");
            break;

          case 'F':
            result += self.$strftime("%Y-%m-%d");
            break;

          case 'v':
            result += self.$strftime("%e-%^b-%4Y");
            break;

          case 'r':
            result += self.$strftime("%I:%M:%S %p");
            break;

          case 'R':
            result += self.$strftime("%H:%M");
            break;

          case 'T':
          case 'X':
            result += self.$strftime("%H:%M:%S");
            break;

          default:
            return full;
        }

        if (upcase) {
          result = result.toUpperCase();
        }

        if (invert) {
          result = result.replace(/[A-Z]/, function(c) { c.toLowerCase() }).
                          replace(/[a-z]/, function(c) { c.toUpperCase() });
        }

        if (pad && (zero || blank)) {
          result = (result).$rjust(isNaN(width) ? 2 : width, blank ? " " : "0");
        }

        return result;
      });
    
    }, TMP_32.$$arity = 1);

    Opal.defn(self, '$sunday?', TMP_33 = function() {
      var self = this;

      return self.$wday() == 0;
    }, TMP_33.$$arity = 0);

    Opal.defn(self, '$thursday?', TMP_34 = function() {
      var self = this;

      return self.$wday() == 4;
    }, TMP_34.$$arity = 0);

    Opal.defn(self, '$to_a', TMP_35 = function $$to_a() {
      var self = this;

      return [self.$sec(), self.$min(), self.$hour(), self.$day(), self.$month(), self.$year(), self.$wday(), self.$yday(), self.$isdst(), self.$zone()];
    }, TMP_35.$$arity = 0);

    Opal.defn(self, '$to_f', TMP_36 = function $$to_f() {
      var self = this;

      return self.getTime() / 1000;
    }, TMP_36.$$arity = 0);

    Opal.defn(self, '$to_i', TMP_37 = function $$to_i() {
      var self = this;

      return parseInt(self.getTime() / 1000, 10);
    }, TMP_37.$$arity = 0);

    Opal.alias(self, 'to_s', 'inspect');

    Opal.defn(self, '$tuesday?', TMP_38 = function() {
      var self = this;

      return self.$wday() == 2;
    }, TMP_38.$$arity = 0);

    Opal.alias(self, 'tv_sec', 'sec');

    Opal.alias(self, 'tv_usec', 'usec');

    Opal.alias(self, 'utc?', 'gmt?');

    Opal.alias(self, 'gmtoff', 'gmt_offset');

    Opal.alias(self, 'utc_offset', 'gmt_offset');

    Opal.defn(self, '$wday', TMP_39 = function $$wday() {
      var self = this;

      return self.is_utc ? self.getUTCDay() : self.getDay();
    }, TMP_39.$$arity = 0);

    Opal.defn(self, '$wednesday?', TMP_40 = function() {
      var self = this;

      return self.$wday() == 3;
    }, TMP_40.$$arity = 0);

    Opal.defn(self, '$year', TMP_41 = function $$year() {
      var self = this;

      return self.is_utc ? self.getUTCFullYear() : self.getFullYear();
    }, TMP_41.$$arity = 0);

    return (Opal.defn(self, '$cweek_cyear', TMP_42 = function $$cweek_cyear() {
      var $a, $b, self = this, jan01 = nil, jan01_wday = nil, first_monday = nil, year = nil, offset = nil, week = nil, dec31 = nil, dec31_wday = nil;

      jan01 = $scope.get('Time').$new(self.$year(), 1, 1);
      jan01_wday = jan01.$wday();
      first_monday = 0;
      year = self.$year();
      if ((($a = ($b = $rb_le(jan01_wday, 4), $b !== false && $b !== nil && $b != null ?jan01_wday['$!='](0) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        offset = $rb_minus(jan01_wday, 1)
        } else {
        offset = $rb_minus($rb_minus(jan01_wday, 7), 1);
        if (offset['$=='](-8)) {
          offset = -1};
      };
      week = ($rb_divide(($rb_plus(self.$yday(), offset)), 7.0)).$ceil();
      if ((($a = $rb_le(week, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('Time').$new($rb_minus(self.$year(), 1), 12, 31).$cweek_cyear()
      } else if (week['$=='](53)) {
        dec31 = $scope.get('Time').$new(self.$year(), 12, 31);
        dec31_wday = dec31.$wday();
        if ((($a = ($b = $rb_le(dec31_wday, 3), $b !== false && $b !== nil && $b != null ?dec31_wday['$!='](0) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          week = 1;
          year = $rb_plus(year, 1);};};
      return [week, year];
    }, TMP_42.$$arity = 0), nil) && 'cweek_cyear';
  })($scope.base, Date);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/struct"] = function(Opal) {
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_ge(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs >= rhs : lhs['$>='](rhs);
  }
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $hash2 = Opal.hash2;

  Opal.add_stubs(['$require', '$include', '$const_name!', '$unshift', '$map', '$coerce_to!', '$new', '$each', '$define_struct_attribute', '$allocate', '$initialize', '$module_eval', '$to_proc', '$const_set', '$==', '$raise', '$<<', '$members', '$define_method', '$instance_eval', '$>', '$length', '$class', '$each_with_index', '$[]=', '$[]', '$hash', '$===', '$<', '$-@', '$size', '$>=', '$include?', '$to_sym', '$instance_of?', '$__id__', '$eql?', '$enum_for', '$name', '$+', '$join', '$inspect', '$each_pair', '$inject', '$flatten', '$to_a', '$values_at']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_8, TMP_9, TMP_11, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_23, TMP_26, TMP_28, TMP_30, TMP_32, TMP_34, TMP_35;

    self.$include($scope.get('Enumerable'));

    Opal.defs(self, '$new', TMP_1 = function(const_name, $a_rest) {
      var $b, $c, TMP_2, $d, TMP_3, $e, self = this, args, $iter = TMP_1.$$p, block = $iter || nil, klass = nil;

      var $args_len = arguments.length, $rest_len = $args_len - 1;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 1; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 1] = arguments[$arg_idx];
      }
      TMP_1.$$p = null;
      if (const_name !== false && const_name !== nil && const_name != null) {
        try {
          const_name = $scope.get('Opal')['$const_name!'](const_name)
        } catch ($err) {
          if (Opal.rescue($err, [$scope.get('TypeError'), $scope.get('NameError')])) {
            try {
              args.$unshift(const_name);
              const_name = nil;
            } finally { Opal.pop_exception() }
          } else { throw $err; }
        }};
      ($b = ($c = args).$map, $b.$$p = (TMP_2 = function(arg){var self = TMP_2.$$s || this;
if (arg == null) arg = nil;
      return $scope.get('Opal')['$coerce_to!'](arg, $scope.get('String'), "to_str")}, TMP_2.$$s = self, TMP_2.$$arity = 1, TMP_2), $b).call($c);
      klass = ($b = ($d = $scope.get('Class')).$new, $b.$$p = (TMP_3 = function(){var self = TMP_3.$$s || this, $a, $e, TMP_4;

      ($a = ($e = args).$each, $a.$$p = (TMP_4 = function(arg){var self = TMP_4.$$s || this;
if (arg == null) arg = nil;
        return self.$define_struct_attribute(arg)}, TMP_4.$$s = self, TMP_4.$$arity = 1, TMP_4), $a).call($e);
        return (function(self) {
          var $scope = self.$$scope, def = self.$$proto, TMP_5;

          Opal.defn(self, '$new', TMP_5 = function($a_rest) {
            var $b, self = this, args, instance = nil;

            var $args_len = arguments.length, $rest_len = $args_len - 0;
            if ($rest_len < 0) { $rest_len = 0; }
            args = new Array($rest_len);
            for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
              args[$arg_idx - 0] = arguments[$arg_idx];
            }
            instance = self.$allocate();
            instance.$$data = {};;
            ($b = instance).$initialize.apply($b, Opal.to_a(args));
            return instance;
          }, TMP_5.$$arity = -1);
          return Opal.alias(self, '[]', 'new');
        })(Opal.get_singleton_class(self));}, TMP_3.$$s = self, TMP_3.$$arity = 0, TMP_3), $b).call($d, self);
      if (block !== false && block !== nil && block != null) {
        ($b = ($e = klass).$module_eval, $b.$$p = block.$to_proc(), $b).call($e)};
      if (const_name !== false && const_name !== nil && const_name != null) {
        $scope.get('Struct').$const_set(const_name, klass)};
      return klass;
    }, TMP_1.$$arity = -2);

    Opal.defs(self, '$define_struct_attribute', TMP_8 = function $$define_struct_attribute(name) {
      var $a, $b, TMP_6, $c, TMP_7, self = this;

      if (self['$==']($scope.get('Struct'))) {
        self.$raise($scope.get('ArgumentError'), "you cannot define attributes to the Struct class")};
      self.$members()['$<<'](name);
      ($a = ($b = self).$define_method, $a.$$p = (TMP_6 = function(){var self = TMP_6.$$s || this;

      return self.$$data[name];}, TMP_6.$$s = self, TMP_6.$$arity = 0, TMP_6), $a).call($b, name);
      return ($a = ($c = self).$define_method, $a.$$p = (TMP_7 = function(value){var self = TMP_7.$$s || this;
if (value == null) value = nil;
      return self.$$data[name] = value;}, TMP_7.$$s = self, TMP_7.$$arity = 1, TMP_7), $a).call($c, "" + (name) + "=");
    }, TMP_8.$$arity = 1);

    Opal.defs(self, '$members', TMP_9 = function $$members() {
      var $a, self = this;
      if (self.members == null) self.members = nil;

      if (self['$==']($scope.get('Struct'))) {
        self.$raise($scope.get('ArgumentError'), "the Struct class has no members")};
      return ((($a = self.members) !== false && $a !== nil && $a != null) ? $a : self.members = []);
    }, TMP_9.$$arity = 0);

    Opal.defs(self, '$inherited', TMP_11 = function $$inherited(klass) {
      var $a, $b, TMP_10, self = this, members = nil;
      if (self.members == null) self.members = nil;

      members = self.members;
      return ($a = ($b = klass).$instance_eval, $a.$$p = (TMP_10 = function(){var self = TMP_10.$$s || this;

      return self.members = members}, TMP_10.$$s = self, TMP_10.$$arity = 0, TMP_10), $a).call($b);
    }, TMP_11.$$arity = 1);

    Opal.defn(self, '$initialize', TMP_13 = function $$initialize($a_rest) {
      var $b, $c, TMP_12, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      if ((($b = $rb_gt(args.$length(), self.$class().$members().$length())) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        self.$raise($scope.get('ArgumentError'), "struct size differs")};
      return ($b = ($c = self.$class().$members()).$each_with_index, $b.$$p = (TMP_12 = function(name, index){var self = TMP_12.$$s || this;
if (name == null) name = nil;if (index == null) index = nil;
      return self['$[]='](name, args['$[]'](index))}, TMP_12.$$s = self, TMP_12.$$arity = 2, TMP_12), $b).call($c);
    }, TMP_13.$$arity = -1);

    Opal.defn(self, '$members', TMP_14 = function $$members() {
      var self = this;

      return self.$class().$members();
    }, TMP_14.$$arity = 0);

    Opal.defn(self, '$hash', TMP_15 = function $$hash() {
      var self = this;

      return $scope.get('Hash').$new(self.$$data).$hash();
    }, TMP_15.$$arity = 0);

    Opal.defn(self, '$[]', TMP_16 = function(name) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](name)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $rb_lt(name, self.$class().$members().$size()['$-@']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too small for struct(size:" + (self.$class().$members().$size()) + ")")};
        if ((($a = $rb_ge(name, self.$class().$members().$size())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$class().$members().$size()) + ")")};
        name = self.$class().$members()['$[]'](name);
      } else if ((($a = $scope.get('String')['$==='](name)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        
        if(!self.$$data.hasOwnProperty(name)) {
          self.$raise($scope.get('NameError').$new("no member '" + (name) + "' in struct", name))
        }
      ;
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (name.$class()) + " into Integer")
      };
      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      return self.$$data[name];
    }, TMP_16.$$arity = 1);

    Opal.defn(self, '$[]=', TMP_17 = function(name, value) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](name)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $rb_lt(name, self.$class().$members().$size()['$-@']())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too small for struct(size:" + (self.$class().$members().$size()) + ")")};
        if ((($a = $rb_ge(name, self.$class().$members().$size())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$class().$members().$size()) + ")")};
        name = self.$class().$members()['$[]'](name);
      } else if ((($a = $scope.get('String')['$==='](name)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.$class().$members()['$include?'](name.$to_sym())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.$raise($scope.get('NameError').$new("no member '" + (name) + "' in struct", name))
        }
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (name.$class()) + " into Integer")
      };
      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      return self.$$data[name] = value;
    }, TMP_17.$$arity = 2);

    Opal.defn(self, '$==', TMP_18 = function(other) {
      var $a, self = this;

      if ((($a = other['$instance_of?'](self.$class())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      
      var recursed1 = {}, recursed2 = {};

      function _eqeq(struct, other) {
        var key, a, b;

        recursed1[(struct).$__id__()] = true;
        recursed2[(other).$__id__()] = true;

        for (key in struct.$$data) {
          a = struct.$$data[key];
          b = other.$$data[key];

          if ($scope.get('Struct')['$==='](a)) {
            if (!recursed1.hasOwnProperty((a).$__id__()) || !recursed2.hasOwnProperty((b).$__id__())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$=='](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    ;
    }, TMP_18.$$arity = 1);

    Opal.defn(self, '$eql?', TMP_19 = function(other) {
      var $a, self = this;

      if ((($a = other['$instance_of?'](self.$class())) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      
      var recursed1 = {}, recursed2 = {};

      function _eqeq(struct, other) {
        var key, a, b;

        recursed1[(struct).$__id__()] = true;
        recursed2[(other).$__id__()] = true;

        for (key in struct.$$data) {
          a = struct.$$data[key];
          b = other.$$data[key];

          if ($scope.get('Struct')['$==='](a)) {
            if (!recursed1.hasOwnProperty((a).$__id__()) || !recursed2.hasOwnProperty((b).$__id__())) {
              if (!_eqeq(a, b)) {
                return false;
              }
            }
          } else {
            if (!(a)['$eql?'](b)) {
              return false;
            }
          }
        }

        return true;
      }

      return _eqeq(self, other);
    ;
    }, TMP_19.$$arity = 1);

    Opal.defn(self, '$each', TMP_20 = function $$each() {
      var $a, $b, TMP_21, $c, TMP_22, self = this, $iter = TMP_20.$$p, $yield = $iter || nil;

      TMP_20.$$p = null;
      if (($yield !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_21 = function(){var self = TMP_21.$$s || this;

        return self.$size()}, TMP_21.$$s = self, TMP_21.$$arity = 0, TMP_21), $a).call($b, "each")
      };
      ($a = ($c = self.$class().$members()).$each, $a.$$p = (TMP_22 = function(name){var self = TMP_22.$$s || this;
if (name == null) name = nil;
      return Opal.yield1($yield, self['$[]'](name));}, TMP_22.$$s = self, TMP_22.$$arity = 1, TMP_22), $a).call($c);
      return self;
    }, TMP_20.$$arity = 0);

    Opal.defn(self, '$each_pair', TMP_23 = function $$each_pair() {
      var $a, $b, TMP_24, $c, TMP_25, self = this, $iter = TMP_23.$$p, $yield = $iter || nil;

      TMP_23.$$p = null;
      if (($yield !== nil)) {
        } else {
        return ($a = ($b = self).$enum_for, $a.$$p = (TMP_24 = function(){var self = TMP_24.$$s || this;

        return self.$size()}, TMP_24.$$s = self, TMP_24.$$arity = 0, TMP_24), $a).call($b, "each_pair")
      };
      ($a = ($c = self.$class().$members()).$each, $a.$$p = (TMP_25 = function(name){var self = TMP_25.$$s || this;
if (name == null) name = nil;
      return Opal.yield1($yield, [name, self['$[]'](name)]);}, TMP_25.$$s = self, TMP_25.$$arity = 1, TMP_25), $a).call($c);
      return self;
    }, TMP_23.$$arity = 0);

    Opal.defn(self, '$length', TMP_26 = function $$length() {
      var self = this;

      return self.$class().$members().$length();
    }, TMP_26.$$arity = 0);

    Opal.alias(self, 'size', 'length');

    Opal.defn(self, '$to_a', TMP_28 = function $$to_a() {
      var $a, $b, TMP_27, self = this;

      return ($a = ($b = self.$class().$members()).$map, $a.$$p = (TMP_27 = function(name){var self = TMP_27.$$s || this;
if (name == null) name = nil;
      return self['$[]'](name)}, TMP_27.$$s = self, TMP_27.$$arity = 1, TMP_27), $a).call($b);
    }, TMP_28.$$arity = 0);

    Opal.alias(self, 'values', 'to_a');

    Opal.defn(self, '$inspect', TMP_30 = function $$inspect() {
      var $a, $b, TMP_29, self = this, result = nil;

      result = "#<struct ";
      if ((($a = ($b = $scope.get('Struct')['$==='](self), $b !== false && $b !== nil && $b != null ?self.$class().$name() : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
        result = $rb_plus(result, "" + (self.$class()) + " ")};
      result = $rb_plus(result, ($a = ($b = self.$each_pair()).$map, $a.$$p = (TMP_29 = function(name, value){var self = TMP_29.$$s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (value.$inspect())}, TMP_29.$$s = self, TMP_29.$$arity = 2, TMP_29), $a).call($b).$join(", "));
      result = $rb_plus(result, ">");
      return result;
    }, TMP_30.$$arity = 0);

    Opal.alias(self, 'to_s', 'inspect');

    Opal.defn(self, '$to_h', TMP_32 = function $$to_h() {
      var $a, $b, TMP_31, self = this;

      return ($a = ($b = self.$class().$members()).$inject, $a.$$p = (TMP_31 = function(h, name){var self = TMP_31.$$s || this;
if (h == null) h = nil;if (name == null) name = nil;
      h['$[]='](name, self['$[]'](name));
        return h;}, TMP_31.$$s = self, TMP_31.$$arity = 2, TMP_31), $a).call($b, $hash2([], {}));
    }, TMP_32.$$arity = 0);

    Opal.defn(self, '$values_at', TMP_34 = function $$values_at($a_rest) {
      var $b, $c, TMP_33, self = this, args;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      args = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        args[$arg_idx - 0] = arguments[$arg_idx];
      }
      args = ($b = ($c = args).$map, $b.$$p = (TMP_33 = function(arg){var self = TMP_33.$$s || this;
if (arg == null) arg = nil;
      return arg.$$is_range ? arg.$to_a() : arg;}, TMP_33.$$s = self, TMP_33.$$arity = 1, TMP_33), $b).call($c).$flatten();
      
      var result = [];
      for (var i = 0, len = args.length; i < len; i++) {
        if (!args[i].$$is_number) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + ((args[i]).$class()) + " into Integer")
        }
        result.push(self['$[]'](args[i]));
      }
      return result;
    ;
    }, TMP_34.$$arity = -1);

    return (Opal.defs(self, '$_load', TMP_35 = function $$_load(args) {
      var $a, $b, self = this, attributes = nil;

      attributes = ($a = args).$values_at.apply($a, Opal.to_a(self.$members()));
      return ($b = self).$new.apply($b, Opal.to_a(attributes));
    }, TMP_35.$$arity = 1), nil) && '_load';
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/io"] = function(Opal) {
  var $a, $b, self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module, $gvars = Opal.gvars;

  Opal.add_stubs(['$attr_accessor', '$size', '$write', '$join', '$map', '$String', '$empty?', '$concat', '$chomp', '$getbyte', '$getc', '$raise', '$new', '$write_proc=', '$extend']);
  (function($base, $super) {
    function $IO(){};
    var self = $IO = $klass($base, $super, 'IO', $IO);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.tty = def.closed = nil;
    Opal.cdecl($scope, 'SEEK_SET', 0);

    Opal.cdecl($scope, 'SEEK_CUR', 1);

    Opal.cdecl($scope, 'SEEK_END', 2);

    Opal.defn(self, '$tty?', TMP_1 = function() {
      var self = this;

      return self.tty;
    }, TMP_1.$$arity = 0);

    Opal.defn(self, '$closed?', TMP_2 = function() {
      var self = this;

      return self.closed;
    }, TMP_2.$$arity = 0);

    self.$attr_accessor("write_proc");

    Opal.defn(self, '$write', TMP_3 = function $$write(string) {
      var self = this;

      self.write_proc(string);
      return string.$size();
    }, TMP_3.$$arity = 1);

    self.$attr_accessor("sync", "tty");

    Opal.defn(self, '$flush', TMP_4 = function $$flush() {
      var self = this;

      return nil;
    }, TMP_4.$$arity = 0);

    (function($base) {
      var $Writable, self = $Writable = $module($base, 'Writable');

      var def = self.$$proto, $scope = self.$$scope, TMP_5, TMP_7, TMP_9;

      Opal.defn(self, '$<<', TMP_5 = function(string) {
        var self = this;

        self.$write(string);
        return self;
      }, TMP_5.$$arity = 1);

      Opal.defn(self, '$print', TMP_7 = function $$print($a_rest) {
        var $b, $c, TMP_6, self = this, args;
        if ($gvars[","] == null) $gvars[","] = nil;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
        self.$write(($b = ($c = args).$map, $b.$$p = (TMP_6 = function(arg){var self = TMP_6.$$s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_6.$$s = self, TMP_6.$$arity = 1, TMP_6), $b).call($c).$join($gvars[","]));
        return nil;
      }, TMP_7.$$arity = -1);

      Opal.defn(self, '$puts', TMP_9 = function $$puts($a_rest) {
        var $b, $c, TMP_8, self = this, args, newline = nil;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        args = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          args[$arg_idx - 0] = arguments[$arg_idx];
        }
        newline = $gvars["/"];
        if ((($b = args['$empty?']()) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
          self.$write($gvars["/"])
          } else {
          self.$write(($b = ($c = args).$map, $b.$$p = (TMP_8 = function(arg){var self = TMP_8.$$s || this;
if (arg == null) arg = nil;
          return self.$String(arg).$chomp()}, TMP_8.$$s = self, TMP_8.$$arity = 1, TMP_8), $b).call($c).$concat([nil]).$join(newline))
        };
        return nil;
      }, TMP_9.$$arity = -1);
    })($scope.base);

    return (function($base) {
      var $Readable, self = $Readable = $module($base, 'Readable');

      var def = self.$$proto, $scope = self.$$scope, TMP_10, TMP_11, TMP_12, TMP_13;

      Opal.defn(self, '$readbyte', TMP_10 = function $$readbyte() {
        var self = this;

        return self.$getbyte();
      }, TMP_10.$$arity = 0);

      Opal.defn(self, '$readchar', TMP_11 = function $$readchar() {
        var self = this;

        return self.$getc();
      }, TMP_11.$$arity = 0);

      Opal.defn(self, '$readline', TMP_12 = function $$readline(sep) {
        var self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        if (sep == null) {
          sep = $gvars["/"];
        }
        return self.$raise($scope.get('NotImplementedError'));
      }, TMP_12.$$arity = -1);

      Opal.defn(self, '$readpartial', TMP_13 = function $$readpartial(integer, outbuf) {
        var self = this;

        if (outbuf == null) {
          outbuf = nil;
        }
        return self.$raise($scope.get('NotImplementedError'));
      }, TMP_13.$$arity = -2);
    })($scope.base);
  })($scope.base, null);
  Opal.cdecl($scope, 'STDERR', $gvars.stderr = $scope.get('IO').$new());
  Opal.cdecl($scope, 'STDIN', $gvars.stdin = $scope.get('IO').$new());
  Opal.cdecl($scope, 'STDOUT', $gvars.stdout = $scope.get('IO').$new());
  (($a = [typeof(process) === 'object' ? function(s){process.stdout.write(s)} : function(s){console.log(s)}]), $b = $scope.get('STDOUT'), $b['$write_proc='].apply($b, $a), $a[$a.length-1]);
  (($a = [typeof(process) === 'object' ? function(s){process.stderr.write(s)} : function(s){console.warn(s)}]), $b = $scope.get('STDERR'), $b['$write_proc='].apply($b, $a), $a[$a.length-1]);
  $scope.get('STDOUT').$extend((($scope.get('IO')).$$scope.get('Writable')));
  return $scope.get('STDERR').$extend((($scope.get('IO')).$$scope.get('Writable')));
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/main"] = function(Opal) {
  var TMP_1, TMP_2, self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$include']);
  Opal.defs(self, '$to_s', TMP_1 = function $$to_s() {
    var self = this;

    return "main";
  }, TMP_1.$$arity = 0);
  return (Opal.defs(self, '$include', TMP_2 = function $$include(mod) {
    var self = this;

    return $scope.get('Object').$include(mod);
  }, TMP_2.$$arity = 1), nil) && 'include';
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/dir"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$[]']);
  return (function($base, $super) {
    function $Dir(){};
    var self = $Dir = $klass($base, $super, 'Dir', $Dir);

    var def = self.$$proto, $scope = self.$$scope;

    return (function(self) {
      var $scope = self.$$scope, def = self.$$proto, TMP_1, TMP_2, TMP_3;

      Opal.defn(self, '$chdir', TMP_1 = function $$chdir(dir) {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil, prev_cwd = nil;

        TMP_1.$$p = null;
        try {
        prev_cwd = Opal.current_dir;
        Opal.current_dir = dir;
        return Opal.yieldX($yield, []);;
        } finally {
          Opal.current_dir = prev_cwd;
        };
      }, TMP_1.$$arity = 1);
      Opal.defn(self, '$pwd', TMP_2 = function $$pwd() {
        var self = this;

        return Opal.current_dir || '.';
      }, TMP_2.$$arity = 0);
      Opal.alias(self, 'getwd', 'pwd');
      return (Opal.defn(self, '$home', TMP_3 = function $$home() {
        var $a, self = this;

        return ((($a = $scope.get('ENV')['$[]']("HOME")) !== false && $a !== nil && $a != null) ? $a : ".");
      }, TMP_3.$$arity = 0), nil) && 'home';
    })(Opal.get_singleton_class(self))
  })($scope.base, null)
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/file"] = function(Opal) {
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$join', '$compact', '$split', '$==', '$first', '$[]=', '$home', '$pwd', '$each', '$pop', '$<<', '$raise', '$respond_to?', '$to_path', '$class', '$nil?', '$is_a?', '$basename', '$empty?', '$rindex', '$[]', '$+', '$-', '$length', '$gsub', '$find', '$=~']);
  return (function($base, $super) {
    function $File(){};
    var self = $File = $klass($base, $super, 'File', $File);

    var def = self.$$proto, $scope = self.$$scope;

    Opal.cdecl($scope, 'Separator', Opal.cdecl($scope, 'SEPARATOR', "/"));

    Opal.cdecl($scope, 'ALT_SEPARATOR', nil);

    Opal.cdecl($scope, 'PATH_SEPARATOR', ":");

    Opal.cdecl($scope, 'FNM_SYSCASE', 0);

    return (function(self) {
      var $scope = self.$$scope, def = self.$$proto, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_8, TMP_9, TMP_10;

      Opal.defn(self, '$expand_path', TMP_2 = function $$expand_path(path, basedir) {
        var $a, $b, TMP_1, self = this, parts = nil, new_parts = nil;

        if (basedir == null) {
          basedir = nil;
        }
        path = [basedir, path].$compact().$join($scope.get('SEPARATOR'));
        parts = path.$split($scope.get('SEPARATOR'));
        new_parts = [];
        if (parts.$first()['$==']("~")) {
          parts['$[]='](0, $scope.get('Dir').$home())};
        if (parts.$first()['$=='](".")) {
          parts['$[]='](0, $scope.get('Dir').$pwd())};
        ($a = ($b = parts).$each, $a.$$p = (TMP_1 = function(part){var self = TMP_1.$$s || this;
if (part == null) part = nil;
        if (part['$==']("..")) {
            return new_parts.$pop()
            } else {
            return new_parts['$<<'](part)
          }}, TMP_1.$$s = self, TMP_1.$$arity = 1, TMP_1), $a).call($b);
        return new_parts.$join($scope.get('SEPARATOR'));
      }, TMP_2.$$arity = -2);
      Opal.alias(self, 'realpath', 'expand_path');
      
      function chompdirsep(path) {
        var last;

        while (path.length > 0) {
          if (isDirSep(path)) {
            last = path;
            path = path.substring(1, path.length);
            while (path.length > 0 && isDirSep(path)) {
              path = inc(path);
            }
            if (path.length == 0) {
              return last;
            }
          }
          else {
            path = inc(path);
          }
        }
        return path;
      }

      function inc(a) {
        return a.substring(1, a.length);
      }

      function skipprefix(path) {
        return path;
      }

      function lastSeparator(path) {
        var tmp, last;

        while (path.length > 0) {
          if (isDirSep(path)) {
            tmp = path;
            path = inc(path);

            while (path.length > 0 && isDirSep(path)) {
              path = inc(path);
            }
            if (!path) {
              break;
            }
            last = tmp;
          }
          else {
            path = inc(path);
          }
        }

        return last;
      }

      function isDirSep(sep) {
        return sep.charAt(0) === $scope.get('SEPARATOR');
      }

      function skipRoot(path) {
        while (path.length > 0 && isDirSep(path)) {
          path = inc(path);
        }
        return path;
      }

      function pointerSubtract(a, b) {
        if (a.length == 0) {
          return b.length;
        }
        return b.indexOf(a);
      }

      function handleSuffix(n, f, p, suffix, name, origName) {
        var suffixMatch;

        if (n >= 0) {
          if (suffix === nil) {
            f = n;
          }
          else {
            suffixMatch = suffix === '.*' ? '\\.\\w+' : suffix.replace(/\?/g, '\\?');
            suffixMatch = new RegExp(suffixMatch + $scope.get('Separator') + '*$').exec(p);
            if (suffixMatch) {
              f = suffixMatch.index;
            }
            else {
              f = n;
            }
          }

          if (f === origName.length) {
            return name;
          }
        }

        return p.substring(0, f);
      }
    
      Opal.defn(self, '$dirname', TMP_3 = function $$dirname(path) {
        var self = this;

        
        if (path === nil) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of nil into String")
        }
        if (path['$respond_to?']("to_path")) {
          path = path.$to_path();
        }
        if (!path.$$is_string) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + (path.$class()) + " into String")
        }

        var root, p;

        root = skipRoot(path);

        // if (root > name + 1) in the C code
        if (root.length == 0) {
          path = path.substring(path.length - 1, path.length);
        }
        else if (root.length - path.length < 0) {
          path = path.substring(path.indexOf(root)-1, path.length);
        }

        p = lastSeparator(root);
        if (!p) {
          p = root;
        }
        if (p === path) {
          return '.';
        }
        return path.substring(0, path.length - p.length);
      ;
      }, TMP_3.$$arity = 1);
      Opal.defn(self, '$basename', TMP_4 = function $$basename(name, suffix) {
        var self = this;

        if (suffix == null) {
          suffix = nil;
        }
        
        var p, q, e, f = 0, n = -1, tmp, pointerMath, origName;

        if (name === nil) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of nil into String")
        }
        if (name['$respond_to?']("to_path")) {
          name = name.$to_path();
        }
        if (!name.$$is_string) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + (name.$class()) + " into String")
        }
        if (suffix !== nil && !suffix.$$is_string) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + (suffix.$class()) + " into String")
        }

        if (name.length == 0) {
          return name;
        }

        origName = name;
        name = skipprefix(name);

        while (isDirSep(name)) {
          tmp = name;
          name = inc(name);
        }

        if (!name) {
          p = tmp;
          f = 1;
        }
        else {
          if (!(p = lastSeparator(name))) {
            p = name;
          }
          else {
            while (isDirSep(p)) {
              p = inc(p);
            }
          }

          n = pointerSubtract(chompdirsep(p), p);

          for (q = p; pointerSubtract(q, p) < n && q.charAt(0) === '.'; q = inc(q)) {
          }

          for (e = null; pointerSubtract(q, p) < n; q = inc(q)) {
            if (q.charAt(0) === '.') {
              e = q;
            }
          }

          if (e) {
            f = pointerSubtract(e, p);
          }
          else {
            f = n;
          }
        }

        return handleSuffix(n, f, p, suffix, name, origName);
      ;
      }, TMP_4.$$arity = -2);
      Opal.defn(self, '$extname', TMP_5 = function $$extname(path) {
        var $a, $b, self = this, filename = nil, last_dot_idx = nil;

        if ((($a = path['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('TypeError'), "no implicit conversion of nil into String")};
        if ((($a = path['$respond_to?']("to_path")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          path = path.$to_path()};
        if ((($a = path['$is_a?']($scope.get('String'))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + (path.$class()) + " into String")
        };
        filename = self.$basename(path);
        if ((($a = filename['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return ""};
        last_dot_idx = filename['$[]']($range(1, -1, false)).$rindex(".");
        if ((($a = (((($b = last_dot_idx['$nil?']()) !== false && $b !== nil && $b != null) ? $b : $rb_plus(last_dot_idx, 1)['$==']($rb_minus(filename.$length(), 1))))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return ""
          } else {
          return filename['$[]']($range(($rb_plus(last_dot_idx, 1)), -1, false))
        };
      }, TMP_5.$$arity = 1);
      Opal.defn(self, '$exist?', TMP_6 = function(path) {
        var self = this;

        return Opal.modules[path] != null;
      }, TMP_6.$$arity = 1);
      Opal.alias(self, 'exists?', 'exist?');
      Opal.defn(self, '$directory?', TMP_8 = function(path) {
        var $a, $b, TMP_7, self = this, files = nil, file = nil;

        files = [];
        
        for (var key in Opal.modules) {
          files.push(key)
        }
      ;
        path = path.$gsub((new RegExp("(^." + $scope.get('SEPARATOR') + "+|" + $scope.get('SEPARATOR') + "+$)")));
        file = ($a = ($b = files).$find, $a.$$p = (TMP_7 = function(file){var self = TMP_7.$$s || this;
if (file == null) file = nil;
        return file['$=~']((new RegExp("^" + path)))}, TMP_7.$$s = self, TMP_7.$$arity = 1, TMP_7), $a).call($b);
        return file;
      }, TMP_8.$$arity = 1);
      Opal.defn(self, '$join', TMP_9 = function $$join($a_rest) {
        var self = this, paths;

        var $args_len = arguments.length, $rest_len = $args_len - 0;
        if ($rest_len < 0) { $rest_len = 0; }
        paths = new Array($rest_len);
        for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
          paths[$arg_idx - 0] = arguments[$arg_idx];
        }
        return paths.$join($scope.get('SEPARATOR')).$gsub((new RegExp("" + $scope.get('SEPARATOR') + "+")), $scope.get('SEPARATOR'));
      }, TMP_9.$$arity = -1);
      return (Opal.defn(self, '$split', TMP_10 = function $$split(path) {
        var self = this;

        return path.$split($scope.get('SEPARATOR'));
      }, TMP_10.$$arity = 1), nil) && 'split';
    })(Opal.get_singleton_class(self));
  })($scope.base, $scope.get('IO'))
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/process"] = function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$to_f', '$now', '$new']);
  (function($base, $super) {
    function $Process(){};
    var self = $Process = $klass($base, $super, 'Process', $Process);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3;

    Opal.cdecl($scope, 'CLOCK_REALTIME', 0);

    Opal.cdecl($scope, 'CLOCK_MONOTONIC', 1);

    Opal.defs(self, '$pid', TMP_1 = function $$pid() {
      var self = this;

      return 0;
    }, TMP_1.$$arity = 0);

    Opal.defs(self, '$times', TMP_2 = function $$times() {
      var self = this, t = nil;

      t = $scope.get('Time').$now().$to_f();
      return (($scope.get('Benchmark')).$$scope.get('Tms')).$new(t, t, t, t, t);
    }, TMP_2.$$arity = 0);

    return (Opal.defs(self, '$clock_gettime', TMP_3 = function $$clock_gettime(clock_id, unit) {
      var self = this;

      if (unit == null) {
        unit = nil;
      }
      return $scope.get('Time').$now().$to_f();
    }, TMP_3.$$arity = -2), nil) && 'clock_gettime';
  })($scope.base, null);
  (function($base, $super) {
    function $Signal(){};
    var self = $Signal = $klass($base, $super, 'Signal', $Signal);

    var def = self.$$proto, $scope = self.$$scope, TMP_4;

    return (Opal.defs(self, '$trap', TMP_4 = function $$trap($a_rest) {
      var self = this;

      return nil;
    }, TMP_4.$$arity = -1), nil) && 'trap'
  })($scope.base, null);
  return (function($base, $super) {
    function $GC(){};
    var self = $GC = $klass($base, $super, 'GC', $GC);

    var def = self.$$proto, $scope = self.$$scope, TMP_5;

    return (Opal.defs(self, '$start', TMP_5 = function $$start() {
      var self = this;

      return nil;
    }, TMP_5.$$arity = 0), nil) && 'start'
  })($scope.base, null);
};

/* Generated by Opal 0.10.3 */
Opal.modules["corelib/unsupported"] = function(Opal) {
  var TMP_30, TMP_31, self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module;

  Opal.add_stubs(['$raise', '$warn', '$%']);
  
  var warnings = {};

  function handle_unsupported_feature(message) {
    switch (Opal.config.unsupported_features_severity) {
    case 'error':
      $scope.get('Kernel').$raise($scope.get('NotImplementedError'), message)
      break;
    case 'warning':
      warn(message)
      break;
    default: // ignore
      // noop
    }
  }

  function warn(string) {
    if (warnings[string]) {
      return;
    }

    warnings[string] = true;
    self.$warn(string);
  }

  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18;

    var ERROR = "String#%s not supported. Mutable String methods are not supported in Opal.";

    Opal.defn(self, '$<<', TMP_1 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("<<"));
    }, TMP_1.$$arity = -1);

    Opal.defn(self, '$capitalize!', TMP_2 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("capitalize!"));
    }, TMP_2.$$arity = -1);

    Opal.defn(self, '$chomp!', TMP_3 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("chomp!"));
    }, TMP_3.$$arity = -1);

    Opal.defn(self, '$chop!', TMP_4 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("chop!"));
    }, TMP_4.$$arity = -1);

    Opal.defn(self, '$downcase!', TMP_5 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("downcase!"));
    }, TMP_5.$$arity = -1);

    Opal.defn(self, '$gsub!', TMP_6 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("gsub!"));
    }, TMP_6.$$arity = -1);

    Opal.defn(self, '$lstrip!', TMP_7 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("lstrip!"));
    }, TMP_7.$$arity = -1);

    Opal.defn(self, '$next!', TMP_8 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("next!"));
    }, TMP_8.$$arity = -1);

    Opal.defn(self, '$reverse!', TMP_9 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("reverse!"));
    }, TMP_9.$$arity = -1);

    Opal.defn(self, '$slice!', TMP_10 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("slice!"));
    }, TMP_10.$$arity = -1);

    Opal.defn(self, '$squeeze!', TMP_11 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("squeeze!"));
    }, TMP_11.$$arity = -1);

    Opal.defn(self, '$strip!', TMP_12 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("strip!"));
    }, TMP_12.$$arity = -1);

    Opal.defn(self, '$sub!', TMP_13 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("sub!"));
    }, TMP_13.$$arity = -1);

    Opal.defn(self, '$succ!', TMP_14 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("succ!"));
    }, TMP_14.$$arity = -1);

    Opal.defn(self, '$swapcase!', TMP_15 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("swapcase!"));
    }, TMP_15.$$arity = -1);

    Opal.defn(self, '$tr!', TMP_16 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("tr!"));
    }, TMP_16.$$arity = -1);

    Opal.defn(self, '$tr_s!', TMP_17 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("tr_s!"));
    }, TMP_17.$$arity = -1);

    return (Opal.defn(self, '$upcase!', TMP_18 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), (ERROR)['$%']("upcase!"));
    }, TMP_18.$$arity = -1), nil) && 'upcase!';
  })($scope.base, null);
  (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_19, TMP_20;

    var ERROR = "Object freezing is not supported by Opal";

    Opal.defn(self, '$freeze', TMP_19 = function $$freeze() {
      var self = this;

      handle_unsupported_feature(ERROR);
      return self;
    }, TMP_19.$$arity = 0);

    Opal.defn(self, '$frozen?', TMP_20 = function() {
      var self = this;

      handle_unsupported_feature(ERROR);
      return false;
    }, TMP_20.$$arity = 0);
  })($scope.base);
  (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_21, TMP_22, TMP_23;

    var ERROR = "Object tainting is not supported by Opal";

    Opal.defn(self, '$taint', TMP_21 = function $$taint() {
      var self = this;

      handle_unsupported_feature(ERROR);
      return self;
    }, TMP_21.$$arity = 0);

    Opal.defn(self, '$untaint', TMP_22 = function $$untaint() {
      var self = this;

      handle_unsupported_feature(ERROR);
      return self;
    }, TMP_22.$$arity = 0);

    Opal.defn(self, '$tainted?', TMP_23 = function() {
      var self = this;

      handle_unsupported_feature(ERROR);
      return false;
    }, TMP_23.$$arity = 0);
  })($scope.base);
  (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self.$$proto, $scope = self.$$scope, TMP_24, TMP_25, TMP_26, TMP_27;

    Opal.defn(self, '$public', TMP_24 = function($a_rest) {
      var self = this, methods;

      var $args_len = arguments.length, $rest_len = $args_len - 0;
      if ($rest_len < 0) { $rest_len = 0; }
      methods = new Array($rest_len);
      for (var $arg_idx = 0; $arg_idx < $args_len; $arg_idx++) {
        methods[$arg_idx - 0] = arguments[$arg_idx];
      }
      
      if (methods.length === 0) {
        self.$$module_function = false;
      }

      return nil;
    
    }, TMP_24.$$arity = -1);

    Opal.alias(self, 'private', 'public');

    Opal.alias(self, 'protected', 'public');

    Opal.alias(self, 'nesting', 'public');

    Opal.defn(self, '$private_class_method', TMP_25 = function $$private_class_method($a_rest) {
      var self = this;

      return self;
    }, TMP_25.$$arity = -1);

    Opal.alias(self, 'public_class_method', 'private_class_method');

    Opal.defn(self, '$private_method_defined?', TMP_26 = function(obj) {
      var self = this;

      return false;
    }, TMP_26.$$arity = 1);

    Opal.defn(self, '$private_constant', TMP_27 = function $$private_constant($a_rest) {
      var self = this;

      return nil;
    }, TMP_27.$$arity = -1);

    Opal.alias(self, 'protected_method_defined?', 'private_method_defined?');

    Opal.alias(self, 'public_instance_methods', 'instance_methods');

    return Opal.alias(self, 'public_method_defined?', 'method_defined?');
  })($scope.base, null);
  (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_28;

    Opal.defn(self, '$private_methods', TMP_28 = function $$private_methods($a_rest) {
      var self = this;

      return [];
    }, TMP_28.$$arity = -1);

    Opal.alias(self, 'private_instance_methods', 'private_methods');
  })($scope.base);
  (function($base) {
    var $Kernel, self = $Kernel = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_29;

    Opal.defn(self, '$eval', TMP_29 = function($a_rest) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), "To use Kernel#eval, you must first require 'opal-parser'. " + ("See https://github.com/opal/opal/blob/" + ($scope.get('RUBY_ENGINE_VERSION')) + "/docs/opal_parser.md for details."));
    }, TMP_29.$$arity = -1)
  })($scope.base);
  Opal.defs(self, '$public', TMP_30 = function($a_rest) {
    var self = this;

    return nil;
  }, TMP_30.$$arity = -1);
  return (Opal.defs(self, '$private', TMP_31 = function($a_rest) {
    var self = this;

    return nil;
  }, TMP_31.$$arity = -1), nil) && 'private';
};

/* Generated by Opal 0.10.3 */
(function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("opal/base");
  self.$require("opal/mini");
  self.$require("corelib/string/inheritance");
  self.$require("corelib/string/encoding");
  self.$require("corelib/math");
  self.$require("corelib/complex");
  self.$require("corelib/rational");
  self.$require("corelib/time");
  self.$require("corelib/struct");
  self.$require("corelib/io");
  self.$require("corelib/main");
  self.$require("corelib/dir");
  self.$require("corelib/file");
  self.$require("corelib/process");
  return self.$require("corelib/unsupported");
})(Opal);

/* Generated by Opal 0.10.3 */
(function(Opal) {
  function $rb_plus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs + rhs : lhs['$+'](rhs);
  }
  function $rb_ge(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs >= rhs : lhs['$>='](rhs);
  }
  function $rb_times(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs * rhs : lhs['$*'](rhs);
  }
  function $rb_minus(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs - rhs : lhs['$-'](rhs);
  }
  function $rb_lt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs < rhs : lhs['$<'](rhs);
  }
  function $rb_divide(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs / rhs : lhs['$/'](rhs);
  }
  function $rb_gt(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs > rhs : lhs['$>'](rhs);
  }
  function $rb_le(lhs, rhs) {
    return (typeof(lhs) === 'number' && typeof(rhs) === 'number') ? lhs <= rhs : lhs['$<='](rhs);
  }
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $range = Opal.range, $hash2 = Opal.hash2, $klass = Opal.klass;

  Opal.add_stubs(['$map', '$strip', '$split', '$[]', '$shift', '$[]=', '$+', '$join', '$===', '$==', '$capitalize', '$=~', '$to_s', '$to_i', '$log', '$keys', '$each', '$p', '$<<', '$attr_accessor', '$new', '$addChild', '$shape', '$plot=', '$graph=', '$add', '$>=', '$call', '$method', '$to_Y', '$*', '$-', '$<', '$empty?', '$xylim', '$zoom', '$syncedChildren', '$synced?', '$select', '$include?', '$min', '$max', '$/', '$update', '$id', '$!', '$each_key', '$showZoom', '$updateZoom', '$>', '$length', '$initStep', '$seq', '$dim', '$to_X', '$mean', '$maxPdf', '$stdDev', '$sample', '$pdf', '$type', '$map!', '$step', '$y', '$to_f', '$abs', '$set', '$initDistrib', '$setAsTransfOf', '$regular?', '$bounds', '$initXYLim', '$adjust', '$drawCont', '$drawDisc', '$**', '$init', '$draw', '$distrib', '$each_with_index', '$floor', '$quantize', '$updateBounds', '$reset', '$drawCurve', '$<=', '$index', '$inject', '$acceptLevelNext', '$dup', '$counts', '$density', '$partBounds', '$graph', '$syncTo', '$setDistrib', '$style', '$attachCurve', '$attachSummary', '$marg', '$attachExpAxis', '$setAlpha', '$setStatMode', '$isModeHidden?', '$setTransf', '$setMLevel', '$setN', '$active=', '$setCurHist', '$setTCL', '$updateTCL', '$updateVisible', '$style=', '$variance', '$setDistribAs', '$setDistribAsTransf', '$xy', '$setNbSim', '$initTransfList', '$name', '$setTransfDistrib', '$-@', '$transfMode', '$quantile', '$applyTransfByIndex', '$seMean_transf_by_index', '$applyTransfByValue', '$allowLevelChange', '$updateHistAEP', '$aep', '$hideAll', '$drawSummary', '$incCptIC', '$drawMean', '$drawSD', '$!=', '$animMode', '$seMean_transf', '$cptICTot=', '$cptICTot', '$playNextAfter', '$addXY', '$transitionInitHist', '$transitionInitPts', '$transitionInitRects', '$transitionInitTime', '$transitionDrawPts', '$transitionFallPts', '$transitionHistPtsAndRects', '$transitionInitExpRects', '$transitionExpPtsAndRects', '$transitionDrawRectsHidden', '$transitionHistPtsAndRectsHidden', '$transitionInitTransf', '$transitionInitPtsTransf', '$transitionPtsTransf', '$transitionDrawIC', '$playLongDensityWithTransfHidden', '$playLongDensityForIC', '$playLongDensityWithTransf', '$playLongDensityBasicHidden', '$playLongDensityBasic', '$power', '$qbounds', '$to_a', '$prepare', '$sort', '$tooltipContent', '$include', '$initTooltip', '$to_x', '$setParamsFrame', '$updateStatTestDistrib', '$playCallables', '$nil?', '$paramsFrame', '$setAlphaFromQuantile', '$cdf', '$getSides', '$typeStatTest', '$drawAreaSide', '$setStyles', '$setPlot', '$alpha=', '$initEvents', '$addCallable', '$attachShapes', '$attachAxis', '$paramsFrame=', '$typeStatTest=', '$setPval', '$meanStyle=', '$sdStyle=', '$getContext']);
  (function($base) {
    var $CqlsAEP, self = $CqlsAEP = $module($base, 'CqlsAEP');

    var def = self.$$proto, $scope = self.$$scope, TMP_7, TMP_244, TMP_245, TMP_246, TMP_247;

    Opal.defs($scope.get('CqlsAEP'), '$parseAnimScript', TMP_7 = function $$parseAnimScript(script) {
      var $a, $b, TMP_1, $c, $d, TMP_3, TMP_6, self = this, code = nil, res = nil, ind = nil, keys = nil, key = nil;

      code = ($a = ($b = script.$strip().$split(/at (\d+)\:/)['$[]']($range(1, -1, false))).$map, $a.$$p = (TMP_1 = function(e){var self = TMP_1.$$s || this, $c, $d, TMP_2;
if (e == null) e = nil;
      return ($c = ($d = e.$split(",")).$map, $c.$$p = (TMP_2 = function(e2){var self = TMP_2.$$s || this;
if (e2 == null) e2 = nil;
        return e2.$strip()}, TMP_2.$$s = self, TMP_2.$$arity = 1, TMP_2), $c).call($d)}, TMP_1.$$s = self, TMP_1.$$arity = 1, TMP_1), $a).call($b);
      res = $hash2([], {});
      while ((($c = ind = code.$shift()) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
      res['$[]='](ind['$[]'](0), $rb_plus($rb_plus("{", ($c = ($d = code.$shift()).$map, $c.$$p = (TMP_3 = function(instr){var self = TMP_3.$$s || this, $e, $f, TMP_4, $g, TMP_5, words = nil, $case = nil, state = nil, level = nil;
if (instr == null) instr = nil;
      words = ($e = ($f = instr.$split(" ")).$map, $e.$$p = (TMP_4 = function(w){var self = TMP_4.$$s || this;
if (w == null) w = nil;
        return w.$strip()}, TMP_4.$$s = self, TMP_4.$$arity = 1, TMP_4), $e).call($f);
        return (function() {$case = words['$[]'](0);if ("set"['$===']($case) || "unset"['$===']($case)) {state = ((function() {if (words['$[]'](0)['$==']("set")) {
          return "true"
          } else {
          return "false"
        }; return nil; })());
        return (function() {$case = words['$[]'](1);if ("anim"['$===']($case)) {return $rb_plus($rb_plus("cqlsAEP.f.setValue('animMode',", state), ");")}else {return $rb_plus($rb_plus($rb_plus($rb_plus("cqlsAEP.f.setValue('check", ($e = ($g = words['$[]']($range(1, -1, false))).$map, $e.$$p = (TMP_5 = function(e){var self = TMP_5.$$s || this;
if (e == null) e = nil;
        return e.$capitalize()}, TMP_5.$$s = self, TMP_5.$$arity = 1, TMP_5), $e).call($g).$join("")), "',"), state), ");")}})();}else if ("speed"['$===']($case)) {return "cqlsAEP.i.scaleTime=" + (words['$[]'](1)) + ";"}else if ("count"['$===']($case)) {if ((($e = words['$[]'](1)['$=~'](/^\d+$/)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
          level = $scope.get('Math').$log(words['$[]'](1).$to_i(), 10).$to_i().$to_s();
          return $rb_plus($rb_plus("cqlsAEP.f.addCount(", level), ");");
        } else if ((($e = words['$[]'](1)['$=~'](/^level\d+$/)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
          return $rb_plus($rb_plus("cqlsAEP.f.setMLevel(", words['$[]'](1)['$[]']($range(5, -1, false))), ");")
          } else {
          return nil
        }}else if ("hist"['$===']($case)) {return "cqlsAEP.f.setLevelOfHist(" + (words['$[]'](1)) + ");"}else if ("end"['$===']($case)) {return "cqlsAEP.i.loop=false;"}else { return nil }})();}, TMP_3.$$s = self, TMP_3.$$arity = 1, TMP_3), $c).call($d).$join("")), "}"))};
      keys = res.$keys();
      script = "";
      ($a = ($c = keys['$[]']($range(0, -1, true))).$each, $a.$$p = (TMP_6 = function(key){var self = TMP_6.$$s || this;
if (key == null) key = nil;
      self.$p(key);
        self.$p(res['$[]'](key));
        return script['$<<']($rb_plus($rb_plus($rb_plus($rb_plus($rb_plus("cqlsAEP.autoPreCycle[", key), "]=\""), res['$[]'](key)), "\";"), "\n"));}, TMP_6.$$s = self, TMP_6.$$arity = 1, TMP_6), $a).call($c);
      key = keys['$[]'](-1);
      script['$<<']($rb_plus($rb_plus($rb_plus($rb_plus("cqlsAEP.autoPostCycle[", key), "]=\""), res['$[]'](key)), "\";"));
      return script;
    }, TMP_7.$$arity = 1);

    (function($base, $super) {
      function $Plot(){};
      var self = $Plot = $klass($base, $super, 'Plot', $Plot);

      var def = self.$$proto, $scope = self.$$scope, TMP_8, TMP_9, TMP_11, TMP_12;

      def.dim = def.frame = def.style = def.axisShape = def.updateCalls = def.graph = def.parent = nil;
      self.$attr_accessor("parent", "frame", "style", "graph", "dim");

      Opal.defn(self, '$initialize', TMP_8 = function $$initialize(dim, style) {
        var $a, self = this;

        if (dim == null) {
          dim = $hash2(["x", "y", "w", "h"], {"x": 0, "y": 0, "w": cqlsAEP.i.dim.w, "h": cqlsAEP.i.dim.h});
        }
        if (style == null) {
          style = $hash2(["bg"], {"bg": "#88FF88"});
        }
        $a = [dim, style], self.dim = $a[0], self.style = $a[1], $a;
        self.parent = new createjs.Container();
        self.frame = new createjs.Shape();
        self.graph = (($scope.get('CqlsAEP')).$$scope.get('Graph')).$new(self.dim);
        self.updateCalls = [];
        self.frame.graphics.beginLinearGradientFill(["#FFF",self.style['$[]']("bg")], [0, 1], 0, self.dim['$[]']("y")+20, 0, self.dim['$[]']("y")+self.dim['$[]']("h")+20).drawRect(self.dim['$[]']("x"),self.dim['$[]']("y"),self.dim['$[]']("w"),self.dim['$[]']("h"));
        self.$addChild(self.frame);
        self.axisShape = new createjs.Shape();
        return self.$addChild(self.axisShape, [self, "drawAxis"]);
      }, TMP_8.$$arity = -1);

      Opal.defn(self, '$addChild', TMP_9 = function $$addChild(child, updateCall, pos) {
        var $a, $b, self = this, shape = nil;

        if (updateCall == null) {
          updateCall = nil;
        }
        if (pos == null) {
          pos = -1;
        }
        shape = child;
        if (updateCall !== false && updateCall !== nil && updateCall != null) {
          self.updateCalls['$<<']([child, updateCall])};
        if ((($a = child.shape == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          shape = child.$shape();
          (($a = [self]), $b = child, $b['$plot='].apply($b, $a), $a[$a.length-1]);
          (($a = [self.graph]), $b = child, $b['$graph='].apply($b, $a), $a[$a.length-1]);
          self.graph.$add(child);
        };
        if ((($a = $rb_ge(pos, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.parent.addChildAt(shape,pos);
          } else {
          return self.parent.addChild(shape);
        };
      }, TMP_9.$$arity = -2);

      Opal.defn(self, '$update', TMP_11 = function $$update() {
        var $a, $b, TMP_10, self = this;

        return ($a = ($b = self.updateCalls).$each, $a.$$p = (TMP_10 = function(k, v){var self = TMP_10.$$s || this, $c, args = nil;
if (k == null) k = nil;if (v == null) v = nil;
        args = v['$[]'](2);
          if (args !== false && args !== nil && args != null) {
            } else {
            args = []
          };
          return ($c = v['$[]'](0).$method(v['$[]'](1))).$call.apply($c, Opal.to_a(args));}, TMP_10.$$s = self, TMP_10.$$arity = 2, TMP_10), $a).call($b);
      }, TMP_11.$$arity = 0);

      return (Opal.defn(self, '$drawAxis', TMP_12 = function $$drawAxis() {
        var self = this;

        return self.axisShape.graphics.ss(3,2).s("#000").mt(self.dim['$[]']("x"),self.graph.$to_Y(0.0)).lt($rb_plus(self.dim['$[]']("x"), self.dim['$[]']("w")),self.graph.$to_Y(0.0)).es();
      }, TMP_12.$$arity = 0), nil) && 'drawAxis';
    })($scope.base, null);

    (function($base, $super) {
      function $Graph(){};
      var self = $Graph = $klass($base, $super, 'Graph', $Graph);

      var def = self.$$proto, $scope = self.$$scope, TMP_13, TMP_14, TMP_15, TMP_16, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_37, TMP_39, TMP_41, TMP_43;

      def.marg = def.dim = def.xylim0 = def.list = def.synced = def.xylim = def.zoom = def.tr = def.syncedChildren = def.active = def.zoomShapes = nil;
      self.$attr_accessor("xylim", "dim", "active", "syncedChildren", "zoom", "marg");

      Opal.defs($scope.get('Graph'), '$adjust', TMP_13 = function $$adjust(inter, more) {
        var self = this, l = nil;

        if (more == null) {
          more = 0;
        }
        l = $rb_times(($rb_minus(inter['$[]'](1), inter['$[]'](0))), more);
        return [$rb_minus(inter['$[]'](0), more), $rb_plus(inter['$[]'](1), more)];
      }, TMP_13.$$arity = -2);

      Opal.defn(self, '$initialize', TMP_14 = function $$initialize(dim, xlim, ylim, style) {
        var $a, self = this;

        if (xlim == null) {
          xlim = [];
        }
        if (ylim == null) {
          ylim = [];
        }
        if (style == null) {
          style = nil;
        }
        $a = [dim, style], self.dim = $a[0], self.style = $a[1], $a;
        self.marg = $hash2(["l", "r", "t", "b"], {"l": 0.1, "r": 0.1, "t": 0.2, "b": 0.1});
        if ((($a = $rb_lt(self.marg['$[]']("l"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("l", $rb_times(self.dim['$[]']("w"), self.marg['$[]']("l")))};
        if ((($a = $rb_lt(self.marg['$[]']("r"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("r", $rb_times(self.dim['$[]']("w"), self.marg['$[]']("r")))};
        if ((($a = $rb_lt(self.marg['$[]']("t"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("t", $rb_times(self.dim['$[]']("h"), self.marg['$[]']("t")))};
        if ((($a = $rb_lt(self.marg['$[]']("b"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("b", $rb_times(self.dim['$[]']("h"), self.marg['$[]']("b")))};
        self.xylim0 = $hash2(["x", "y"], {"x": xlim, "y": ylim});
        $a = [[], []], self.list = $a[0], self.active = $a[1], $a;
        if ((($a = self.xylim0['$[]']("x")['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.list['$<<'](self.xylim0)
        };
        self.xylim = $hash2(["x", "y"], {"x": [], "y": []});
        self.tr = $hash2([], {});
        self.zoom = $hash2(["x0", "x1", "y0", "y1", "active"], {"x0": 0.0, "x1": 0.0, "y0": 0.0, "y1": 0.0, "active": false});
        return self.syncedChildren = [];
      }, TMP_14.$$arity = -2);

      Opal.defn(self, '$syncTo', TMP_15 = function $$syncTo(graph) {
        var self = this;

        self.xylim = graph.$xylim();
        self.zoom = graph.$zoom();
        graph.$syncedChildren()['$<<'](self);
        return self.synced = true;
      }, TMP_15.$$arity = 1);

      Opal.defn(self, '$synced?', TMP_16 = function() {
        var self = this;

        return self.synced;
      }, TMP_16.$$arity = 0);

      Opal.defn(self, '$update', TMP_23 = function $$update(active) {
        var $a, $b, TMP_17, $c, TMP_18, $d, TMP_19, $e, TMP_20, $f, TMP_21, $g, TMP_22, self = this, list = nil;

        if (active == null) {
          active = self.active;
        }
        if ((($a = self['$synced?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          list = ($a = ($b = self.list).$select, $a.$$p = (TMP_17 = function(e){var self = TMP_17.$$s || this, $c;
if (e == null) e = nil;
          return ((($c = active['$empty?']()) !== false && $c !== nil && $c != null) ? $c : (active['$include?'](e['$[]'](1))))}, TMP_17.$$s = self, TMP_17.$$arity = 1, TMP_17), $a).call($b);
          self.xylim['$[]']("x")['$[]='](0, ($a = ($c = list).$map, $a.$$p = (TMP_18 = function(e){var self = TMP_18.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("x")['$[]'](0);}, TMP_18.$$s = self, TMP_18.$$arity = 1, TMP_18), $a).call($c).$min());
          self.xylim['$[]']("x")['$[]='](1, ($a = ($d = list).$map, $a.$$p = (TMP_19 = function(e){var self = TMP_19.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("x")['$[]'](1);}, TMP_19.$$s = self, TMP_19.$$arity = 1, TMP_19), $a).call($d).$max());
          self.xylim['$[]']("y")['$[]='](0, ($a = ($e = list).$map, $a.$$p = (TMP_20 = function(e){var self = TMP_20.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("y")['$[]'](0);}, TMP_20.$$s = self, TMP_20.$$arity = 1, TMP_20), $a).call($e).$min());
          self.xylim['$[]']("y")['$[]='](1, ($a = ($f = list).$map, $a.$$p = (TMP_21 = function(e){var self = TMP_21.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("y")['$[]'](1);}, TMP_21.$$s = self, TMP_21.$$arity = 1, TMP_21), $a).call($f).$max());
        };
        $a = [$rb_divide(($rb_minus($rb_minus($rb_plus(self.xylim['$[]']("x")['$[]'](1), self.zoom['$[]']("x1")), self.xylim['$[]']("x")['$[]'](0)), self.zoom['$[]']("x0"))), ($rb_minus($rb_minus(self.dim['$[]']("w"), self.marg['$[]']("l")), self.marg['$[]']("r")))), $rb_divide(($rb_minus($rb_minus($rb_plus(self.xylim['$[]']("y")['$[]'](0), self.zoom['$[]']("y0")), self.xylim['$[]']("y")['$[]'](1)), self.zoom['$[]']("y1"))), ($rb_minus($rb_minus(self.dim['$[]']("h"), self.marg['$[]']("t")), self.marg['$[]']("b"))))], self.tr['$[]=']("ax", $a[0]), self.tr['$[]=']("ay", $a[1]), $a;
        $a = [$rb_minus($rb_plus(self.xylim['$[]']("x")['$[]'](0), self.zoom['$[]']("x0")), $rb_times(self.tr['$[]']("ax"), ($rb_plus(self.dim['$[]']("x"), self.marg['$[]']("l"))))), $rb_minus($rb_plus(self.xylim['$[]']("y")['$[]'](1), self.zoom['$[]']("y1")), $rb_times(self.tr['$[]']("ay"), ($rb_plus(self.dim['$[]']("y"), self.marg['$[]']("t")))))], self.tr['$[]=']("bx", $a[0]), self.tr['$[]=']("by", $a[1]), $a;
        if ((($a = self.syncedChildren['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil
          } else {
          return ($a = ($g = self.syncedChildren).$each, $a.$$p = (TMP_22 = function(c){var self = TMP_22.$$s || this;
if (c == null) c = nil;
          return c.$update()}, TMP_22.$$s = self, TMP_22.$$arity = 1, TMP_22), $a).call($g)
        };
      }, TMP_23.$$arity = -1);

      Opal.defn(self, '$setActive', TMP_24 = function $$setActive(ary) {
        var self = this;

        return self.active = ary;
      }, TMP_24.$$arity = 1);

      Opal.defn(self, '$add', TMP_25 = function $$add(element, mode, id) {
        var $a, self = this, $case = nil;

        if (mode == null) {
          mode = "element";
        }
        if (id == null) {
          id = nil;
        }
        if ((($a = self['$synced?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return (function() {$case = mode;if ("element"['$===']($case)) {if ((($a = element.$xylim()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.list['$<<'](["element", ((($a = id) !== false && $a !== nil && $a != null) ? $a : element.$id()), element]);
          return self.$update();
          } else {
          return nil
        }}else if ("xylim"['$===']($case)) {self.list['$<<'](["xylim", id, element]);
        return self.$update();}else { return nil }})();
      }, TMP_25.$$arity = -2);

      Opal.defn(self, '$addXYLim', TMP_26 = function $$addXYLim(id, x0, x1, y0, y1) {
        var self = this;

        return self.$add($hash2(["x", "y"], {"x": [x0, x1], "y": [y0, y1]}), "xylim", id);
      }, TMP_26.$$arity = 5);

      Opal.defn(self, '$to_x', TMP_27 = function $$to_x(x) {
        var self = this;

        return $rb_plus($rb_times(self.tr['$[]']("ax"), x), self.tr['$[]']("bx"));
      }, TMP_27.$$arity = 1);

      Opal.defn(self, '$to_X', TMP_28 = function $$to_X(x) {
        var self = this;

        return $rb_divide(($rb_minus(x, self.tr['$[]']("bx"))), self.tr['$[]']("ax"));
      }, TMP_28.$$arity = 1);

      Opal.defn(self, '$to_y', TMP_29 = function $$to_y(y) {
        var self = this;

        return $rb_plus($rb_times(self.tr['$[]']("ay"), y), self.tr['$[]']("by"));
      }, TMP_29.$$arity = 1);

      Opal.defn(self, '$to_Y', TMP_30 = function $$to_Y(y) {
        var self = this;

        return $rb_divide(($rb_minus(y, self.tr['$[]']("by"))), self.tr['$[]']("ay"));
      }, TMP_30.$$arity = 1);

      Opal.defn(self, '$to_local', TMP_31 = function $$to_local(x, y) {
        var self = this;

        return [$rb_plus($rb_times(self.tr['$[]']("ax"), x), self.tr['$[]']("bx")), $rb_plus($rb_times(self.tr['$[]']("ay"), y), self.tr['$[]']("by"))];
      }, TMP_31.$$arity = 2);

      Opal.defn(self, '$to_global', TMP_32 = function $$to_global(x, y) {
        var self = this;

        return [$rb_divide(($rb_minus(x, self.tr['$[]']("bx"))), self.tr['$[]']("ax")), $rb_divide(($rb_minus(y, self.tr['$[]']("by"))), self.tr['$[]']("ay"))];
      }, TMP_32.$$arity = 2);

      Opal.defn(self, '$zoomActive', TMP_33 = function $$zoomActive() {
        var self = this;

        return self.zoom['$[]']("active");
      }, TMP_33.$$arity = 0);

      Opal.defn(self, '$toggleZoomTo', TMP_37 = function $$toggleZoomTo(plot, type) {
        var $a, $b, TMP_34, $c, TMP_35, $d, TMP_36, self = this, keys = nil;

        if (type == null) {
          type = ["xpos", "xneg", "ypos", "reset"];
        }
        self.zoom['$[]=']("active", self.zoom['$[]']("active")['$!']());
        if ((($a = self.zoom['$[]']("active")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = self.zoomShapes) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            } else {
            self.zoomShapes = $hash2([], {});
            keys = [];
            if ((($a = type['$include?']("xpos")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["xposmore", "xposless"])};
            if ((($a = type['$include?']("xneg")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["xnegmore", "xnegless"])};
            if ((($a = type['$include?']("ypos")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["yposmore", "yposless"])};
            if ((($a = type['$include?']("yneg")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["ynegmore", "ynegless"])};
            if ((($a = type['$include?']("reset")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["reset"])};
            ($a = ($b = keys).$each, $a.$$p = (TMP_34 = function(k){var self = TMP_34.$$s || this;
              if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
            return self.zoomShapes['$[]='](k, new createjs.Shape())}, TMP_34.$$s = self, TMP_34.$$arity = 1, TMP_34), $a).call($b);
          };
          ($a = ($c = self.zoomShapes).$each_key, $a.$$p = (TMP_35 = function(k){var self = TMP_35.$$s || this;
            if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
          
						plot.parent.addChild(self.zoomShapes['$[]'](k))
					;}, TMP_35.$$s = self, TMP_35.$$arity = 1, TMP_35), $a).call($c);
          return self.$showZoom();
          } else {
          return ($a = ($d = self.zoomShapes).$each_key, $a.$$p = (TMP_36 = function(k){var self = TMP_36.$$s || this;
            if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
          
						plot.parent.removeChild(self.zoomShapes['$[]'](k))
					;}, TMP_36.$$s = self, TMP_36.$$arity = 1, TMP_36), $a).call($d)
        };
      }, TMP_37.$$arity = -2);

      Opal.defn(self, '$showZoom', TMP_39 = function $$showZoom() {
        var $a, $b, TMP_38, self = this, size = nil, inter = nil;

        size = 40;
        inter = 15;
        return ($a = ($b = self.zoomShapes).$each_key, $a.$$p = (TMP_38 = function(k){var self = TMP_38.$$s || this, $case = nil;
          if (self.zoomShapes == null) self.zoomShapes = nil;
          if (self.dim == null) self.dim = nil;
if (k == null) k = nil;
        self.zoomShapes['$[]'](k).alpha=0.5;
          return (function() {$case = k;if ("xposmore"['$===']($case)) {return self.zoomShapes['$[]']("xposmore").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")-1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(self.dim['$[]']("w")-1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(self.dim['$[]']("w")-0.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("xposless"['$===']($case)) {return self.zoomShapes['$[]']("xposless").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")-1.5*size-inter,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(self.dim['$[]']("w")-1.5*size-inter,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(self.dim['$[]']("w")-2.5*size-inter,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("xnegmore"['$===']($case)) {return self.zoomShapes['$[]']("xnegmore").graphics.c().s("#000").f("#FFF").mt(1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(0.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("xnegless"['$===']($case)) {return self.zoomShapes['$[]']("xnegless").graphics.c().s("#000").f("#FFF").mt(1.5*size+inter,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(1.5*size+inter,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(2.5*size+inter,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("ynegmore"['$===']($case)) {return self.zoomShapes['$[]']("ynegmore").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0),self.dim['$[]']("h")-0.5*size).cp() ;}else if ("ynegless"['$===']($case)) {return self.zoomShapes['$[]']("ynegless").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size-inter).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size-inter).lt($rb_divide(self.dim['$[]']("w"), 2.0),self.dim['$[]']("h")-2.5*size-inter).cp() ;}else if ("yposmore"['$===']($case)) {return self.zoomShapes['$[]']("yposmore").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0),0.5*size).cp() ;}else if ("yposless"['$===']($case)) {return self.zoomShapes['$[]']("yposless").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),1.5*size+inter).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),1.5*size+inter).lt($rb_divide(self.dim['$[]']("w"), 2.0),2.5*size+inter).cp() ;}else if ("reset"['$===']($case)) {return self.zoomShapes['$[]']("reset").graphics.c().s("#000").f("#FFF").drawRect($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2), $rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2),size,size) ;}else { return nil }})();}, TMP_38.$$s = self, TMP_38.$$arity = 1, TMP_38), $a).call($b);
      }, TMP_39.$$arity = 0);

      Opal.defn(self, '$hitZoom', TMP_41 = function $$hitZoom(x, y) {
        var $a, $b, TMP_40, self = this, select = nil;

        if ((($a = self.zoom['$[]']("active")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          return nil
        };
        select = "none";
        (function(){var $brk = Opal.new_brk(); try {return ($a = ($b = self.zoomShapes).$each_key, $a.$$p = (TMP_40 = function(k){var self = TMP_40.$$s || this;
          if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
        if(self.zoomShapes['$[]'](k).hitTest(x, y)) {select=k};;
          if (select['$==']("none")) {
            return nil
            } else {
            
            Opal.brk(nil, $brk)
          };}, TMP_40.$$s = self, TMP_40.$$brk = $brk, TMP_40.$$arity = 1, TMP_40), $a).call($b)
        } catch (err) { if (err === $brk) { return err.$v } else { throw err } }})();
        if (select['$==']("none")) {
          return select};
        self.$updateZoom(select);
        return select;
      }, TMP_41.$$arity = 2);

      return (Opal.defn(self, '$updateZoom', TMP_43 = function $$updateZoom(mode, times) {
        var $a, $b, TMP_42, self = this, step = nil;

        if (times == null) {
          times = 1;
        }
        step = $rb_divide(0.1, 2);
        return ($a = ($b = ($range(0, times, true))).$each, $a.$$p = (TMP_42 = function(){var self = TMP_42.$$s || this, $c, $d, $case = nil;
          if (self.zoom == null) self.zoom = nil;
          if (self.xylim == null) self.xylim = nil;

        return (function() {$case = mode;if ("xposmore"['$===']($case)) {return ($c = "x1", $d = self.zoom, $d['$[]=']($c, $rb_plus($d['$[]']($c), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))))}else if ("xposless"['$===']($case)) {if ((($c = $rb_lt(self.zoom['$[]']("x1"), $rb_times(($rb_minus(step, $rb_divide(1, 2))), ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return nil
            } else {
            return self.zoom['$[]=']("x1", $rb_minus(self.zoom['$[]']("x1"), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0))))))
          }}else if ("xnegmore"['$===']($case)) {return self.zoom['$[]=']("x0", $rb_minus(self.zoom['$[]']("x0"), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0))))))}else if ("xnegless"['$===']($case)) {if ((($c = $rb_gt(self.zoom['$[]']("x0"), $rb_times(($rb_minus($rb_divide(1, 2), step)), ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return nil
            } else {
            return ($c = "x0", $d = self.zoom, $d['$[]=']($c, $rb_plus($d['$[]']($c), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))))
          }}else if ("yposmore"['$===']($case)) {return ($c = "y1", $d = self.zoom, $d['$[]=']($c, $rb_plus($d['$[]']($c), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))))}else if ("yposless"['$===']($case)) {if ((($c = $rb_lt(self.zoom['$[]']("y1"), $rb_times(($rb_minus(step, $rb_divide(1, 2))), ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return nil
            } else {
            return self.zoom['$[]=']("y1", $rb_minus(self.zoom['$[]']("y1"), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0))))))
          }}else if ("ynegmore"['$===']($case)) {return self.zoom['$[]=']("y0", $rb_minus(self.zoom['$[]']("y1"), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0))))))}else if ("ynegless"['$===']($case)) {if ((($c = $rb_gt(self.zoom['$[]']("y0"), $rb_times(($rb_minus($rb_divide(1, 2), step)), ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return nil
            } else {
            return ($c = "y0", $d = self.zoom, $d['$[]=']($c, $rb_plus($d['$[]']($c), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))))
          }}else if ("reset"['$===']($case)) {return self.zoom['$[]=']("x0", self.zoom['$[]=']("x1", self.zoom['$[]=']("y0", self.zoom['$[]=']("y1", 0.0))))}else { return nil }})()}, TMP_42.$$s = self, TMP_42.$$arity = 0, TMP_42), $a).call($b);
      }, TMP_43.$$arity = -2), nil) && 'updateZoom';
    })($scope.base, null);

    (function($base, $super) {
      function $Child(){};
      var self = $Child = $klass($base, $super, 'Child', $Child);

      var def = self.$$proto, $scope = self.$$scope, TMP_44;

      self.$attr_accessor("id", "plot", "graph", "shape", "style", "xylim");

      return (Opal.defn(self, '$initialize', TMP_44 = function $$initialize() {
        var self = this;

        return nil;
      }, TMP_44.$$arity = 0), nil) && 'initialize';
    })($scope.base, null);

    (function($base, $super) {
      function $Curve(){};
      var self = $Curve = $klass($base, $super, 'Curve', $Curve);

      var def = self.$$proto, $scope = self.$$scope, TMP_45, TMP_46, TMP_47, TMP_48, TMP_49, TMP_50, TMP_51, TMP_53, TMP_54, TMP_56, TMP_57, TMP_58, TMP_59, TMP_60, TMP_62, TMP_63, TMP_64, TMP_66, TMP_68;

      def.type = def.bounds = def.length = def.plot = def.expAxisShape = def.graph = def.summaryShapes = def.distrib = def.step = def.x = def.y = def.shape = def.style = nil;
      self.$attr_accessor("distrib", "bounds", "kind", "type", "style");

      Opal.defn(self, '$initialize', TMP_45 = function $$initialize(id, type, bounds, style, length) {
        var $a, $b, self = this, $case = nil;

        if (id == null) {
          id = nil;
        }
        if (type == null) {
          type = "cont";
        }
        if (bounds == null) {
          bounds = [0, 1];
        }
        if (style == null) {
          style = $hash2(["close", "stroke", "fill", "thickness"], {"close": true, "stroke": "#000", "fill": "rgba(200,200,255,0.5)", "thickness": 3});
        }
        if (length == null) {
          length = 512;
        }
        if ((($a = (($b = Opal.cvars['@@curveCpt']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@curveCpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil && $a != null) ? $a : $rb_plus("curve", ((Opal.cvars['@@curveCpt'] = $rb_plus((($b = Opal.cvars['@@curveCpt']) == null ? nil : $b), 1))).$to_s()));
        self.type = type;
        $case = self.type;if ("cont"['$===']($case)) {$a = [bounds, length], self.bounds = $a[0], self.length = $a[1], $a}else if ("disc"['$===']($case)) {self.bounds = bounds;
        self.length = self.bounds.$length();
        self.$initStep();};
        self.style = style;
        self.shape = new createjs.Shape();
        self.x = $scope.get('CqlsAEP').$seq(self.bounds['$[]'](0), self.bounds['$[]'](1), self.length);
        self.kind = "density";
        self.summaryShapes = [new createjs.Shape(), new createjs.Shape()];
        return self.expAxisShape = new createjs.Shape();
      }, TMP_45.$$arity = -1);

      Opal.defn(self, '$attachExpAxis', TMP_46 = function $$attachExpAxis(ratio) {
        var self = this;

        return self.plot.$addChild(self.expAxisShape, [self, "drawExpAxis", [ratio]]);
      }, TMP_46.$$arity = 1);

      Opal.defn(self, '$drawExpAxis', TMP_47 = function $$drawExpAxis(ratio) {
        var self = this;

        self.expAxisShape.visible=true;
        return self.expAxisShape.graphics.c().s("#000").ss(1).mt(self.graph.$dim()['$[]']("x"),$rb_times(self.graph.$dim()['$[]']("h"), ratio)).lt($rb_plus(self.graph.$dim()['$[]']("x"), self.graph.$dim()['$[]']("w")),$rb_times(self.graph.$dim()['$[]']("h"), ratio));
      }, TMP_47.$$arity = 1);

      Opal.defn(self, '$attachSummary', TMP_48 = function $$attachSummary() {
        var self = this;

        self.plot.$addChild(self.summaryShapes['$[]'](0), [self, "drawMean"]);
        return self.plot.$addChild(self.summaryShapes['$[]'](1), [self, "drawSD"]);
      }, TMP_48.$$arity = 0);

      Opal.defn(self, '$drawMean', TMP_49 = function $$drawMean() {
        var self = this;

        return self.summaryShapes['$[]'](0).graphics.c().s("#000").ss(1).mt(self.graph.$to_X(self.distrib.$mean()),self.graph.$dim()['$[]']("y")).lt(self.graph.$to_X(self.distrib.$mean()),$rb_plus(self.graph.$dim()['$[]']("y"), self.graph.$dim()['$[]']("h")));
      }, TMP_49.$$arity = 0);

      Opal.defn(self, '$drawSD', TMP_50 = function $$drawSD() {
        var $a, self = this, x = nil, y = nil, h = nil;

        $a = [10, 10], x = $a[0], y = $a[1], $a;
        h = $rb_divide(self.distrib.$maxPdf(), 2.0);
        if (self.type['$==']("disc")) {
          h = $rb_divide(h, self.step)};
        h = self.graph.$to_Y(h);
        
				self.summaryShapes['$[]'](1).graphics.c().s("#000").ss(1)
				.mt(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev()))+x,h-y)
				.lt(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev()))+x,h+y)
				.mt(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev()))-x,h-y)
				.mt(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev()))-x,h+y)
			;
      }, TMP_50.$$arity = 0);

      Opal.defn(self, '$sample', TMP_51 = function $$sample(n) {
        var self = this;

        if (n == null) {
          n = 1;
        }
        return self.distrib.$sample(n);
      }, TMP_51.$$arity = -1);

      Opal.defn(self, '$y', TMP_53 = function $$y(x) {
        var $a, $b, TMP_52, self = this, y = nil;

        y = self.distrib.$pdf(x);
        if (self.distrib.$type()['$==']("disc")) {
          ($a = ($b = y)['$map!'], $a.$$p = (TMP_52 = function(e){var self = TMP_52.$$s || this;
            if (self.distrib == null) self.distrib = nil;
if (e == null) e = nil;
          return $rb_divide(e, self.distrib.$step())}, TMP_52.$$s = self, TMP_52.$$arity = 1, TMP_52), $a).call($b)};
        y = y.map(function(e) {return Math.random()*e;});
        return y;
      }, TMP_53.$$arity = 1);

      Opal.defn(self, '$xy', TMP_54 = function $$xy(n) {
        var self = this, x = nil, y = nil;

        if (n == null) {
          n = 1;
        }
        x = self.$sample(n);
        y = self.$y(x);
        return $hash2(["x", "y"], {"x": x, "y": y});
      }, TMP_54.$$arity = -1);

      Opal.defn(self, '$initStep', TMP_56 = function $$initStep() {
        var $a, $b, TMP_55, self = this;

        return self.step = ($a = ($b = ($range(1, self.bounds.$length(), true))).$map, $a.$$p = (TMP_55 = function(i){var self = TMP_55.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return ($rb_minus(self.bounds['$[]'](i), self.bounds['$[]']($rb_minus(i, 1)))).$abs()}, TMP_55.$$s = self, TMP_55.$$arity = 1, TMP_55), $a).call($b).$min().$to_f();
      }, TMP_56.$$arity = 0);

      Opal.defn(self, '$setDistrib', TMP_57 = function $$setDistrib(name, params) {
        var self = this;

        self.distrib = $scope.get('Distribution').$new();
        self.distrib.$set(name, params);
        return self.$initDistrib();
      }, TMP_57.$$arity = 2);

      Opal.defn(self, '$setDistribAs', TMP_58 = function $$setDistribAs(dist) {
        var self = this;

        self.distrib = dist;
        return self.$initDistrib();
      }, TMP_58.$$arity = 1);

      Opal.defn(self, '$setDistribAsTransf', TMP_59 = function $$setDistribAsTransf(transf, dist) {
        var self = this;

        self.distrib = $scope.get('Distribution').$new();
        self.distrib.$setAsTransfOf(dist, transf);
        return self.$initDistrib();
      }, TMP_59.$$arity = 2);

      Opal.defn(self, '$regular?', TMP_60 = function() {
        var self = this;

        return self.distrib['$regular?']();
      }, TMP_60.$$arity = 0);

      Opal.defn(self, '$initDistrib', TMP_62 = function $$initDistrib() {
        var $a, $b, TMP_61, self = this, $case = nil;

        self.type = self.distrib.$type();
        self.bounds = self.distrib.$bounds();
        $case = self.type;if ("cont"['$===']($case)) {self.x = $scope.get('CqlsAEP').$seq(self.bounds['$[]'](0), self.bounds['$[]'](1), self.length)}else if ("disc"['$===']($case)) {self.$initStep();
        self.x = self.bounds;};
        self.y = self.distrib.$pdf(self.x);
        if (self.type['$==']("disc")) {
          ($a = ($b = self.y)['$map!'], $a.$$p = (TMP_61 = function(e){var self = TMP_61.$$s || this;
            if (self.step == null) self.step = nil;
if (e == null) e = nil;
          return $rb_divide(e, self.step)}, TMP_61.$$s = self, TMP_61.$$arity = 1, TMP_61), $a).call($b)};
        return self.$initXYLim();
      }, TMP_62.$$arity = 0);

      Opal.defn(self, '$initXYLim', TMP_63 = function $$initXYLim() {
        var self = this, xlim = nil;

        xlim = (function() {if (self.type['$==']("cont")) {
          return self.bounds
          } else {
          return [$rb_minus(self.bounds['$[]'](0), $rb_divide(self.step, 2.0)), $rb_plus(self.bounds['$[]'](-1), $rb_divide(self.step, 2.0))]
        }; return nil; })();
        return self.xylim = $hash2(["x", "y"], {"x": $scope.get('Graph').$adjust(xlim), "y": $scope.get('Graph').$adjust([0, self.y.$max()])});
      }, TMP_63.$$arity = 0);

      Opal.defn(self, '$draw', TMP_64 = function $$draw(shape, graph, style) {
        var self = this;

        if (shape == null) {
          shape = self.shape;
        }
        if (graph == null) {
          graph = self.graph;
        }
        if (style == null) {
          style = self.style;
        }
        if (self.type['$==']("cont")) {
          return self.$drawCont(shape, graph, style)
          } else {
          return self.$drawDisc(shape, graph, style)
        };
      }, TMP_64.$$arity = -1);

      Opal.defn(self, '$drawCont', TMP_66 = function $$drawCont(shape, graph, style) {
        var $a, $b, TMP_65, self = this;

        if (shape == null) {
          shape = self.shape;
        }
        if (graph == null) {
          graph = self.graph;
        }
        if (style == null) {
          style = self.style;
        }
        
				shape.graphics.clear();
				if(style['$[]']("close")) {shape.graphics.f(style['$[]']("fill"));}
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        shape.graphics.mt(graph.$to_X(self.x['$[]'](0)),graph.$to_Y(0.0));
        ($a = ($b = ($range(0, self.x.$length(), true))).$each, $a.$$p = (TMP_65 = function(i){var self = TMP_65.$$s || this;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        return shape.graphics.lt(graph.$to_X(self.x['$[]'](i)),graph.$to_Y(self.y['$[]'](i)));}, TMP_65.$$s = self, TMP_65.$$arity = 1, TMP_65), $a).call($b);
        shape.graphics.lt(graph.$to_X(self.x['$[]'](-1)),graph.$to_Y(0.0));
        if ((($a = style['$[]']("close")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return shape.graphics.cp();
          } else {
          return nil
        };
      }, TMP_66.$$arity = -1);

      return (Opal.defn(self, '$drawDisc', TMP_68 = function $$drawDisc(shape, graph, style) {
        var $a, $b, TMP_67, self = this, s = nil;

        if (shape == null) {
          shape = self.shape;
        }
        if (graph == null) {
          graph = self.graph;
        }
        if (style == null) {
          style = self.style;
        }
        s = $rb_divide(self.step, 2.0);
        
				shape.graphics.clear();
				if(style['$[]']("close")) {shape.graphics.f(style['$[]']("fill"));}
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        return ($a = ($b = ($range(0, self.x.$length(), true))).$each, $a.$$p = (TMP_67 = function(i){var self = TMP_67.$$s || this, $c;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        
				 	shape.graphics.mt(graph.$to_X($rb_minus(self.x['$[]'](i), s)),graph.$to_Y(0.0))
					.lt(graph.$to_X($rb_minus(self.x['$[]'](i), s)),graph.$to_Y(self.y['$[]'](i)))
					.lt(graph.$to_X($rb_plus(self.x['$[]'](i), s)),graph.$to_Y(self.y['$[]'](i)))
			 		.lt(graph.$to_X($rb_plus(self.x['$[]'](i), s)),graph.$to_Y(0.0))
			 	;
          if ((($c = style['$[]']("close")) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return shape.graphics.cp();
            } else {
            return nil
          };}, TMP_67.$$s = self, TMP_67.$$arity = 1, TMP_67), $a).call($b);
      }, TMP_68.$$arity = -1), nil) && 'drawDisc';
    })($scope.base, $scope.get('Child'));

    (function($base, $super) {
      function $Hist(){};
      var self = $Hist = $klass($base, $super, 'Hist', $Hist);

      var def = self.$$proto, $scope = self.$$scope, TMP_69, TMP_70, TMP_71, TMP_72, TMP_73, TMP_74, TMP_75, TMP_78, TMP_79, TMP_80, TMP_81, TMP_86, TMP_87, TMP_88, TMP_89, TMP_91, TMP_93, TMP_95, TMP_98, TMP_100, TMP_105;

      def.type = def.curve = def.curveShape = def.graph = def.style = def.plot = def.summaryShapes = def.mean = def.step = def.sd = def.bounds = def.nbPart = def.ind = def.nbTot = def.cptICTot = def.levelNext = def.levels = def.cpt = def.level = def.shape = def.aep = nil;
      self.$attr_accessor("bounds", "level", "levels", "nbPart", "nbTot", "curveShape", "type", "aep", "style", "cptICTot");

      Opal.defn(self, '$initialize', TMP_69 = function $$initialize(id, type, bounds, style, levels) {
        var $a, $b, self = this, $case = nil;

        if (id == null) {
          id = nil;
        }
        if (type == null) {
          type = "cont";
        }
        if (bounds == null) {
          bounds = [0, 1];
        }
        if (style == null) {
          style = $hash2(["hist", "mean", "sd", "curve"], {"hist": $hash2(["fill", "stroke"], {"fill": "rgba(100,100,255,0.5)", "stroke": "#000000"}), "mean": $hash2(["stroke", "thickness"], {"stroke": "rgba(100,100,255,1)", "thickness": 1}), "sd": $hash2(["stroke", "thickness", "fill"], {"stroke": "rgba(100,100,255,1)", "thickness": 1, "fill": "rgba(100,100,255,1)"}), "curve": $hash2(["close", "fill", "stroke", "thickness"], {"close": false, "fill": "#000", "stroke": "rgba(0,0,0,.4)", "thickness": 3})});
        }
        if (levels == null) {
          levels = 8;
        }
        if ((($a = (($b = Opal.cvars['@@histCpt']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@histCpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil && $a != null) ? $a : $rb_plus("hist", ((Opal.cvars['@@histCpt'] = $rb_plus((($b = Opal.cvars['@@histCpt']) == null ? nil : $b), 1))).$to_s()));
        self.type = type;
        $case = self.type;if ("cont"['$===']($case)) {$a = [bounds, levels, 4], self.bounds = $a[0], self.levels = $a[1], self.level = $a[2], $a;
        self.nbPart = (2)['$**'](levels);}else if ("disc"['$===']($case)) {self.bounds = bounds};
        self.$init();
        self.style = style;
        self.shape = new createjs.Shape();
        self.curveShape = new createjs.Shape();
        self.aep = $hash2([], {});
        self.aepLastStep = $hash2([], {});
        return self.summaryShapes = [new createjs.Shape(), new createjs.Shape()];
      }, TMP_69.$$arity = -1);

      Opal.defn(self, '$drawCurve', TMP_70 = function $$drawCurve() {
        var self = this;

        return self.curve.$draw(self.curveShape, self.graph, self.style['$[]']("curve"));
      }, TMP_70.$$arity = 0);

      Opal.defn(self, '$attachSummary', TMP_71 = function $$attachSummary() {
        var self = this;

        self.plot.$addChild(self.summaryShapes['$[]'](0), [self, "drawMean"]);
        return self.plot.$addChild(self.summaryShapes['$[]'](1), [self, "drawSD"]);
      }, TMP_71.$$arity = 0);

      Opal.defn(self, '$drawMean', TMP_72 = function $$drawMean() {
        var self = this;

        return self.summaryShapes['$[]'](0).graphics.c().s(self.style['$[]']("mean")['$[]']("stroke")).ss(self.style['$[]']("mean")['$[]']("thickness")).mt(self.graph.$to_X(self.mean['$[]'](0)),self.graph.$dim()['$[]']("y")).lt(self.graph.$to_X(self.mean['$[]'](0)),$rb_plus(self.graph.$dim()['$[]']("y"), self.graph.$dim()['$[]']("h")));
      }, TMP_72.$$arity = 0);

      Opal.defn(self, '$drawSD', TMP_73 = function $$drawSD() {
        var $a, self = this, x = nil, y = nil, h = nil;

        $a = [10, 10], x = $a[0], y = $a[1], $a;
        h = $rb_divide(self.curve.$distrib().$maxPdf(), 2.0);
        if (self.type['$==']("disc")) {
          h = $rb_divide(h, self.step)};
        h = self.graph.$to_Y(h);
        
				self.summaryShapes['$[]'](1).graphics.c().s(self.style['$[]']("mean")['$[]']("stroke")).ss(1)
				.mt(self.graph.$to_X($rb_minus(self.mean['$[]'](0), self.sd))+x,h-y)
				.lt(self.graph.$to_X($rb_minus(self.mean['$[]'](0), self.sd)),h)
				.lt(self.graph.$to_X($rb_minus(self.mean['$[]'](0), self.sd))+x,h+y)
				.mt(self.graph.$to_X($rb_minus(self.mean['$[]'](0), self.sd)),h)
				.lt(self.graph.$to_X($rb_plus(self.mean['$[]'](0), self.sd)),h)
				.lt(self.graph.$to_X($rb_plus(self.mean['$[]'](0), self.sd))-x,h-y)
				.mt(self.graph.$to_X($rb_plus(self.mean['$[]'](0), self.sd)),h)
				.lt(self.graph.$to_X($rb_plus(self.mean['$[]'](0), self.sd))-x,h+y)
			;
      }, TMP_73.$$arity = 0);

      Opal.defn(self, '$updateBounds', TMP_74 = function $$updateBounds() {
        var self = this;

        return self.bounds = self.curve.$bounds();
      }, TMP_74.$$arity = 0);

      Opal.defn(self, '$regular?', TMP_75 = function() {
        var self = this;

        return self.curve['$regular?']();
      }, TMP_75.$$arity = 0);

      Opal.defn(self, '$init', TMP_78 = function $$init() {
        var $a, $b, TMP_76, $c, TMP_77, self = this, $case = nil;

        $case = self.type;if ("cont"['$===']($case)) {self.step = $rb_divide(($rb_minus(self.bounds['$[]'](1), self.bounds['$[]'](0))).$to_f(), self.nbPart);
        $a = [$rb_times([0], self.nbPart), 0], self.cpt = $a[0], self.nbTot = $a[1], $a;
        self.outside = $rb_times([0], 2);}else if ("disc"['$===']($case)) {self.step = ($a = ($b = ($range(1, self.bounds.$length(), true))).$map, $a.$$p = (TMP_76 = function(i){var self = TMP_76.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return ($rb_minus(self.bounds['$[]'](i), self.bounds['$[]']($rb_minus(i, 1)))).$abs()}, TMP_76.$$s = self, TMP_76.$$arity = 1, TMP_76), $a).call($b).$min();
        $a = [$rb_times([0], self.bounds.$length()), 0], self.cpt = $a[0], self.nbTot = $a[1], $a;
        self.outside = $rb_times([0], 2);
        if ((($a = self['$regular?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.ind = $hash2([], {});
          ($a = ($c = self.bounds).$each_with_index, $a.$$p = (TMP_77 = function(v, i){var self = TMP_77.$$s || this;
            if (self.ind == null) self.ind = nil;
if (v == null) v = nil;if (i == null) i = nil;
          return self.ind['$[]='](v, i)}, TMP_77.$$s = self, TMP_77.$$arity = 2, TMP_77), $a).call($c);
        };};
        return $a = [[0, 0], 0, 0], self.mean = $a[0], self.sd = $a[1], self.cptICTot = $a[2], $a;
      }, TMP_78.$$arity = 0);

      Opal.defn(self, '$index', TMP_79 = function $$index(x, step) {
        var $a, self = this;

        if (step == null) {
          step = self.step;
        }
        if ((($a = self['$regular?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return ($rb_divide(($rb_minus(x, self.bounds['$[]'](0))), step)).$floor()
          } else {
          return self.ind['$[]']($scope.get('CqlsAEP').$quantize(x))
        };
      }, TMP_79.$$arity = -2);

      Opal.defn(self, '$reset', TMP_80 = function $$reset(type) {
        var self = this;

        if (type == null) {
          type = nil;
        }
        self.type = (function() {if (type !== false && type !== nil && type != null) {
          return type
          } else {
          return self.curve.$type()
        }; return nil; })();
        self.$updateBounds();
        return self.$init();
      }, TMP_80.$$arity = -1);

      Opal.defn(self, '$attachCurve', TMP_81 = function $$attachCurve(curve) {
        var self = this;

        self.curve = curve;
        self.$reset();
        self.graph.$add(self.curve);
        self.$drawCurve();
        self.plot.$addChild(self.curveShape, [self, "drawCurve"], 1);
        return self.curveShape.visible=false;
      }, TMP_81.$$arity = 1);

      Opal.defn(self, '$add', TMP_86 = function $$add(x) {
        var $a, $b, TMP_82, $c, TMP_83, $d, TMP_84, $e, TMP_85, self = this, $case = nil;

        $case = self.type;if ("cont"['$===']($case)) {($a = ($b = x).$each, $a.$$p = (TMP_82 = function(e){var self = TMP_82.$$s || this, $c, $d;
          if (self.bounds == null) self.bounds = nil;
          if (self.cpt == null) self.cpt = nil;
          if (self.outside == null) self.outside = nil;
if (e == null) e = nil;
        if ((($c = ($d = $rb_le(self.bounds['$[]'](0), e), $d !== false && $d !== nil && $d != null ?$rb_le(e, self.bounds['$[]'](-1)) : $d)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return ($c = self.$index(e), $d = self.cpt, $d['$[]=']($c, $rb_plus($d['$[]']($c), 1)))
            } else {
            if ((($c = $rb_lt(e, self.bounds['$[]'](0))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
              ($c = 0, $d = self.outside, $d['$[]=']($c, $rb_plus($d['$[]']($c), 1)))};
            if ((($c = $rb_gt(e, self.bounds['$[]'](-1))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
              return ($c = 1, $d = self.outside, $d['$[]=']($c, $rb_plus($d['$[]']($c), 1)))
              } else {
              return nil
            };
          }}, TMP_82.$$s = self, TMP_82.$$arity = 1, TMP_82), $a).call($b)}else if ("disc"['$===']($case)) {($a = ($c = x).$each, $a.$$p = (TMP_83 = function(e){var self = TMP_83.$$s || this, $d, $e, i = nil;
          if (self.bounds == null) self.bounds = nil;
          if (self.cpt == null) self.cpt = nil;
          if (self.outside == null) self.outside = nil;
if (e == null) e = nil;
        i = self.$index(e);
          if ((($d = (($e = $rb_le(0, i)) ? $rb_lt(i, self.bounds.$length()) : $rb_le(0, i))) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            return ($d = i, $e = self.cpt, $e['$[]=']($d, $rb_plus($e['$[]']($d), 1)))
            } else {
            if ((($d = $rb_lt(i, 0)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
              ($d = 0, $e = self.outside, $e['$[]=']($d, $rb_plus($e['$[]']($d), 1)))};
            if ((($d = $rb_ge(i, self.bounds.$length())) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
              return ($d = 1, $e = self.outside, $e['$[]=']($d, $rb_plus($e['$[]']($d), 1)))
              } else {
              return nil
            };
          };}, TMP_83.$$s = self, TMP_83.$$arity = 1, TMP_83), $a).call($c)};
        self.mean['$[]='](0, ($a = ($d = x).$inject, $a.$$p = (TMP_84 = function(e, e2){var self = TMP_84.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
        return e = $rb_plus(e, e2)}, TMP_84.$$s = self, TMP_84.$$arity = 2, TMP_84), $a).call($d, $rb_times(self.nbTot.$to_f(), self.mean['$[]'](0))));
        self.mean['$[]='](1, ($a = ($e = x).$inject, $a.$$p = (TMP_85 = function(e, e2){var self = TMP_85.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
        return e = $rb_plus(e, e2['$**'](2))}, TMP_85.$$s = self, TMP_85.$$arity = 2, TMP_85), $a).call($e, $rb_times(self.nbTot.$to_f(), self.mean['$[]'](1))));
        self.nbTot = $rb_plus(self.nbTot, x.$length());
        self.mean['$[]='](0, $rb_divide(self.mean['$[]'](0), self.nbTot.$to_f()));
        self.mean['$[]='](1, $rb_divide(self.mean['$[]'](1), self.nbTot.$to_f()));
        return self.sd = Math.sqrt($rb_minus(self.mean['$[]'](1), self.mean['$[]'](0)['$**'](2)));
      }, TMP_86.$$arity = 1);

      Opal.defn(self, '$incCptIC', TMP_87 = function $$incCptIC(cpt) {
        var self = this;

        return self.cptICTot = $rb_plus(self.cptICTot, cpt);
      }, TMP_87.$$arity = 1);

      Opal.defn(self, '$level', TMP_88 = function $$level(val, mode) {
        var $a, $b, self = this, level = nil;

        if (val == null) {
          val = 0;
        }
        if (mode == null) {
          mode = "inc";
        }
        if (self.type['$==']("disc")) {
          return nil};
        if ((($a = (($b = mode['$==']("inc")) ? val['$=='](0) : mode['$==']("inc"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.levelNext};
        level = $rb_plus(((function() {if (mode['$==']("inc")) {
          return self.levelNext
          } else {
          return 0
        }; return nil; })()), val);
        if ((($a = $rb_lt(level, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          level = 0};
        if ((($a = $rb_gt(level, self.levels)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          level = self.levels};
        self.levelNext = level;
        self.$acceptLevelNext();
        return self.levelNext;
      }, TMP_88.$$arity = -1);

      Opal.defn(self, '$acceptLevelNext', TMP_89 = function $$acceptLevelNext() {
        var $a, self = this;

        if ((($a = cqlsAEP.i.allowLevelChange) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.level = self.levelNext
          } else {
          return nil
        };
      }, TMP_89.$$arity = 0);

      Opal.defn(self, '$counts', TMP_91 = function $$counts() {
        var $a, $b, TMP_90, self = this, cptLevel = nil;

        if (self.type['$==']("disc")) {
          return self.cpt.$dup()};
        cptLevel = $rb_times([0], ((2)['$**'](self.level)));
        ($a = ($b = ($range(0, self.nbPart, true))).$each, $a.$$p = (TMP_90 = function(i){var self = TMP_90.$$s || this, $c, $d;
          if (self.levels == null) self.levels = nil;
          if (self.level == null) self.level = nil;
          if (self.cpt == null) self.cpt = nil;
if (i == null) i = nil;
        return ($c = $rb_divide(i, (2)['$**'](($rb_minus(self.levels, self.level)))), $d = cptLevel, $d['$[]=']($c, $rb_plus($d['$[]']($c), self.cpt['$[]'](i))))}, TMP_90.$$s = self, TMP_90.$$arity = 1, TMP_90), $a).call($b);
        return cptLevel;
      }, TMP_91.$$arity = 0);

      Opal.defn(self, '$prob', TMP_93 = function $$prob() {
        var $a, $b, TMP_92, self = this;

        return ($a = ($b = self.$counts()).$map, $a.$$p = (TMP_92 = function(e){var self = TMP_92.$$s || this;
          if (self.nbTot == null) self.nbTot = nil;
if (e == null) e = nil;
        return $rb_divide(e.$to_f(), self.nbTot.$to_f())}, TMP_92.$$s = self, TMP_92.$$arity = 1, TMP_92), $a).call($b);
      }, TMP_93.$$arity = 0);

      Opal.defn(self, '$density', TMP_95 = function $$density(nbTot) {
        var $a, $b, TMP_94, self = this, cpt = nil, step = nil, nbTotal = nil;

        if (nbTot == null) {
          nbTot = nil;
        }
        cpt = self.$counts();
        step = ((function() {if (self.type['$==']("cont")) {
          return $rb_times(self.step, ((2)['$**'](($rb_minus(self.levels, self.level)))))
          } else {
          return self.step
        }; return nil; })());
        nbTotal = (function() {if (nbTot !== false && nbTot !== nil && nbTot != null) {
          return nbTot
          } else {
          return self.nbTot
        }; return nil; })();
        return ($a = ($b = cpt).$map, $a.$$p = (TMP_94 = function(e){var self = TMP_94.$$s || this;
if (e == null) e = nil;
        return $rb_divide($rb_divide(e.$to_f(), nbTotal.$to_f()), step)}, TMP_94.$$s = self, TMP_94.$$arity = 1, TMP_94), $a).call($b);
      }, TMP_95.$$arity = -1);

      Opal.defn(self, '$partBounds', TMP_98 = function $$partBounds() {
        var $a, $b, TMP_96, $c, TMP_97, self = this, $case = nil, step = nil, s = nil;

        return (function() {$case = self.type;if ("cont"['$===']($case)) {step = $rb_times(self.step, ((2)['$**'](($rb_minus(self.levels, self.level)))));
        return $rb_plus((($a = ($b = ($range(0, ((2)['$**'](self.level)), true))).$map, $a.$$p = (TMP_96 = function(i){var self = TMP_96.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return $rb_plus(self.bounds['$[]'](0), $rb_times(i, step))}, TMP_96.$$s = self, TMP_96.$$arity = 1, TMP_96), $a).call($b)), [self.bounds['$[]'](1)]);}else if ("disc"['$===']($case)) {s = $rb_divide(self.step, 2.0);
        return $rb_plus((($a = ($c = self.bounds).$map, $a.$$p = (TMP_97 = function(v){var self = TMP_97.$$s || this;
if (v == null) v = nil;
        return $rb_minus(v, s)}, TMP_97.$$s = self, TMP_97.$$arity = 1, TMP_97), $a).call($c)), [$rb_plus(self.bounds['$[]'](-1), s)]);}else { return nil }})();
      }, TMP_98.$$arity = 0);

      Opal.defn(self, '$draw', TMP_100 = function $$draw(nbTot) {
        var $a, $b, TMP_99, self = this, d = nil, b = nil, l = nil;

        if (nbTot == null) {
          nbTot = nil;
        }
        d = self.$density(nbTot);
        b = self.$partBounds();
        l = (function() {if (self.type['$==']("cont")) {
          return (2)['$**'](self.level)
          } else {
          return self.bounds.$length()
        }; return nil; })();
        self.shape.graphics.c().f(self.style['$[]']("hist")['$[]']("fill")).s(self.style['$[]']("hist")['$[]']("stroke")).mt(self.graph.$to_X(b['$[]'](0)),self.graph.$to_Y(0.0));
        ($a = ($b = ($range(0, (l), true))).$each, $a.$$p = (TMP_99 = function(i){var self = TMP_99.$$s || this;
          if (self.type == null) self.type = nil;
          if (self.shape == null) self.shape = nil;
          if (self.graph == null) self.graph = nil;
          if (self.step == null) self.step = nil;
if (i == null) i = nil;
        
					if(self.type['$==']("disc")) {
						self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i)),self.graph.$to_Y(0));
					}
					self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i)),self.graph.$to_Y(d['$[]'](i)));
					if(self['$regular?']()) {
						self.shape.graphics.lt(self.graph.$to_X(b['$[]']($rb_plus(i, 1))),self.graph.$to_Y(d['$[]'](i)));
						if(self.type['$==']("disc")) {
							self.shape.graphics.lt(self.graph.$to_X(b['$[]']($rb_plus(i, 1))),self.graph.$to_Y(0));
						}
					}
					else {//then implicitly discrete
						self.shape.graphics.lt(self.graph.$to_X($rb_plus(b['$[]'](i), self.step)),self.graph.$to_Y(d['$[]'](i)));
						self.shape.graphics.lt(self.graph.$to_X($rb_plus(b['$[]'](i), self.step)),self.graph.$to_Y(0));
					}
				;}, TMP_99.$$s = self, TMP_99.$$arity = 1, TMP_99), $a).call($b);
        self.shape.graphics.lt(self.graph.$to_X(b['$[]'](-1)),self.graph.$to_Y(0.0));
        return self.shape.graphics.cp();
      }, TMP_100.$$arity = -1);

      return (Opal.defn(self, '$updateHistAEP', TMP_105 = function $$updateHistAEP(x, mode) {
        var $a, $b, TMP_101, $c, TMP_102, $d, TMP_103, $e, TMP_104, self = this, $case = nil;

        if (mode == null) {
          mode = "normal";
        }
        self.aep['$[]=']("cpt", ((function() {if (mode['$==']("normal")) {
          return self.$counts()
          } else {
          return ($rb_times([0], ((function() {if (self.type['$==']("disc")) {
            return self.bounds.$length()
            } else {
            return ((2)['$**'](self.level))
          }; return nil; })())))
        }; return nil; })()));
        self.aep['$[]=']("step", (function() {if (self.type['$==']("cont")) {
          return $rb_divide(($rb_minus(self.bounds['$[]'](1), self.bounds['$[]'](0))).$to_f(), ((2)['$**'](self.level)).$to_f())
          } else {
          return self.step
        }; return nil; })());
        self.aep['$[]=']("nbTot", $rb_plus(((function() {if ((($a = (["normal", "reduced"]['$include?'](mode))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.nbTot
          } else {
          return 0
        }; return nil; })()), x.$length()));
        $a = [[], []], self.aep['$[]=']("xRect", $a[0]), self.aep['$[]=']("yRect", $a[1]), $a;
        $case = self.type;if ("cont"['$===']($case)) {($a = ($b = x).$each_with_index, $a.$$p = (TMP_101 = function(e, i){var self = TMP_101.$$s || this, $c, $d, pos = nil;
          if (self.bounds == null) self.bounds = nil;
          if (self.aep == null) self.aep = nil;
if (e == null) e = nil;if (i == null) i = nil;
        if ((($c = ($d = $rb_le(self.bounds['$[]'](0), e), $d !== false && $d !== nil && $d != null ?$rb_le(e, self.bounds['$[]'](-1)) : $d)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            pos = ($rb_divide(($rb_minus(e, self.bounds['$[]'](0))), (self.aep['$[]']("step")))).$floor();
            self.aep['$[]']("xRect")['$[]='](i, $rb_plus(self.bounds['$[]'](0), ($rb_times(self.aep['$[]']("step"), pos.$to_f()))));
            ($c = pos, $d = self.aep['$[]']("cpt"), $d['$[]=']($c, $rb_plus($d['$[]']($c), 1)));
            return self.aep['$[]']("yRect")['$[]='](i, $rb_divide($rb_divide(self.aep['$[]']("cpt")['$[]'](pos).$to_f(), self.aep['$[]']("nbTot").$to_f()), self.aep['$[]']("step")));
            } else {
            pos = ($rb_divide(($rb_minus(e, self.bounds['$[]'](0))), (self.aep['$[]']("step")))).$floor();
            self.aep['$[]']("xRect")['$[]='](i, $rb_plus(self.bounds['$[]'](0), ($rb_times(self.aep['$[]']("step"), pos.$to_f()))));
            return self.aep['$[]']("yRect")['$[]='](i, 0);
          }}, TMP_101.$$s = self, TMP_101.$$arity = 2, TMP_101), $a).call($b)}else if ("disc"['$===']($case)) {($a = ($c = x).$each_with_index, $a.$$p = (TMP_102 = function(e, i){var self = TMP_102.$$s || this, $d, $e, pos = nil;
          if (self.bounds == null) self.bounds = nil;
          if (self.aep == null) self.aep = nil;
if (e == null) e = nil;if (i == null) i = nil;
        pos = self.$index(e);
          if ((($d = (($e = $rb_le(0, pos)) ? $rb_lt(pos, self.bounds.$length()) : $rb_le(0, pos))) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
            self.aep['$[]']("xRect")['$[]='](i, $rb_minus(self.bounds['$[]'](pos), $rb_divide(self.aep['$[]']("step"), 2.0)));
            ($d = pos, $e = self.aep['$[]']("cpt"), $e['$[]=']($d, $rb_plus($e['$[]']($d), 1)));
            return self.aep['$[]']("yRect")['$[]='](i, $rb_divide($rb_divide(self.aep['$[]']("cpt")['$[]'](pos).$to_f(), self.aep['$[]']("nbTot").$to_f()), self.aep['$[]']("step")));
            } else {
            self.aep['$[]']("xRect")['$[]='](i, $rb_minus(e, $rb_divide(self.aep['$[]']("step"), 2.0)));
            return self.aep['$[]']("yRect")['$[]='](i, 0);
          };}, TMP_102.$$s = self, TMP_102.$$arity = 2, TMP_102), $a).call($c)};
        if (mode['$==']("new")) {
          self.aep['$[]=']("mean", [$rb_divide((($a = ($d = x).$inject, $a.$$p = (TMP_103 = function(e, e2){var self = TMP_103.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = $rb_plus(e, e2)}, TMP_103.$$s = self, TMP_103.$$arity = 2, TMP_103), $a).call($d, 0)), self.aep['$[]']("nbTot")), $rb_divide((($a = ($e = x).$inject, $a.$$p = (TMP_104 = function(e, e2){var self = TMP_104.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = $rb_plus(e, e2['$**'](2))}, TMP_104.$$s = self, TMP_104.$$arity = 2, TMP_104), $a).call($e, 0)), self.aep['$[]']("nbTot"))]);
          return self.aep['$[]=']("sd", Math.sqrt($rb_minus(self.aep['$[]']("mean")['$[]'](1), self.aep['$[]']("mean")['$[]'](0)['$**'](2))));
          } else {
          return nil
        };
      }, TMP_105.$$arity = -2), nil) && 'updateHistAEP';
    })($scope.base, $scope.get('Child'));

    (function($base, $super) {
      function $Play(){};
      var self = $Play = $klass($base, $super, 'Play', $Play);

      var def = self.$$proto, $scope = self.$$scope, TMP_106, TMP_108, TMP_109, TMP_110, TMP_111, TMP_112, TMP_113, TMP_114, TMP_115, TMP_116, TMP_117, TMP_118, TMP_119, TMP_120, TMP_121, TMP_122, TMP_123, TMP_124, TMP_125, TMP_127, TMP_129, TMP_131, TMP_133, TMP_136, TMP_139, TMP_141, TMP_143, TMP_146, TMP_149, TMP_151, TMP_153, TMP_155, TMP_157, TMP_158, TMP_159, TMP_160, TMP_168, TMP_169, TMP_171, TMP_175, TMP_176, TMP_178, TMP_180, TMP_182, TMP_185, TMP_187, TMP_189, TMP_191, TMP_193, TMP_195, TMP_198, TMP_199, TMP_200, TMP_201, TMP_203, TMP_204, TMP_205, TMP_206, TMP_207, TMP_208, TMP_209, TMP_210, TMP_211;

      def.plotExp = def.plotHist = def.graphHist = def.graphExp = def.exp = def.hist = def.ratioExpAxis = def.transf = def.checkTCL = def.n = def.x = def.y = def.mLevel = def.mLevels = def.nold = def.transfList = def.curIndHist = def.histCur = def.statMode = def.n01 = def.alpha = def.ind = def.aep = def.w = def.h = def.wX = def.hY = def.modeHidden = def.time = def.cptIC = def.nbSim = nil;
      self.$attr_accessor("exp");

      Opal.defn(self, '$initialize', TMP_106 = function $$initialize(plotExp, plotHist) {
        var $a, self = this;

        if (plotExp == null) {
          plotExp = cqlsAEP.s.plot;
        }
        if (plotHist == null) {
          plotHist = cqlsAEP.h.plot;
        }
        
				cqlsAEP.actors={pt:[],rect:[],line:[]};
				cqlsAEP.tweens={pt:[],rect:[],line:[]};
	    		cqlsAEP.m.nbsSimMax=cqlsAEP.m.nbsSim["1000"][cqlsAEP.m.nbsSim["1000"].length-1];
	    		//console.log("nbsSImMax="+cqlsAEP.m.nbsSimMax);
	     		for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
					var rect=new createjs.Shape();
	    			cqlsAEP.actors.rect.push(rect);
			    	rect.visible=false;
			    	cqlsAEP.m.stage.addChild(rect);
	    		}
	    		for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
					var line=new createjs.Shape();
	    			cqlsAEP.actors.line.push(line);
			    	line.visible=false;
			    	cqlsAEP.m.stage.addChild(line);
	    		}
	    		for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
	    			var pt=new createjs.Shape();
	    			cqlsAEP.actors.pt.push(pt);
			    	pt.visible=false;
			    	pt.x=0;pt.y=0;
			    	cqlsAEP.m.stage.addChild(pt);
	    		}
			
        self.stage = cqlsAEP.m.stage;
        $a = [plotExp, plotHist], self.plotExp = $a[0], self.plotHist = $a[1], $a;
        $a = [self.plotExp.$graph(), self.plotHist.$graph()], self.graphExp = $a[0], self.graphHist = $a[1], $a;
        self.graphHist.$syncTo(self.graphExp);
        self.exp = [$scope.get('Curve').$new(), $scope.get('Curve').$new()];
        self.$setDistrib();
        self.$setDistrib("chi2", [10], 1);
        self.plotExp.$addChild(self.exp['$[]'](0));
        self.plotExp.$addChild(self.exp['$[]'](1));
        self.exp['$[]'](1).$style()['$[]=']("fill", createjs.Graphics.getRGB(200,200,200,.3));
        self.exp['$[]'](1).$style()['$[]=']("thickness", 1);
        self.hist = [$scope.get('Hist').$new(), $scope.get('Hist').$new()];
        self.plotHist.$addChild(self.hist['$[]'](0));
        self.plotHist.$addChild(self.hist['$[]'](1));
        self.hist['$[]'](0).$attachCurve(self.exp['$[]'](0));
        self.hist['$[]'](1).$attachCurve(self.exp['$[]'](1));
        self.exp['$[]'](0).$attachSummary();
        self.exp['$[]'](1).$attachSummary();
        self.hist['$[]'](0).$attachSummary();
        self.hist['$[]'](1).$attachSummary();
        self.ratioExpAxis = [$rb_minus(1, $rb_divide(self.graphExp.$marg()['$[]']("b"), self.graphExp.$dim()['$[]']("h"))), 0.2];
        self.yExpAxis = [$rb_times(self.ratioExpAxis['$[]'](0), self.graphExp.$dim()['$[]']("h")), $rb_times(self.ratioExpAxis['$[]'](1), self.graphExp.$dim()['$[]']("h"))];
        self.exp['$[]'](0).$attachExpAxis(self.ratioExpAxis['$[]'](0));
        self.exp['$[]'](1).$attachExpAxis(self.ratioExpAxis['$[]'](1));
        self.n01 = $scope.get('Distribution').$new("normal", [0, 1]);
        self.$setAlpha(0.05);
        self.$setStatMode("none");
        self['$isModeHidden?']();
        self.$setTransf();
        self.$reset();
        $a = [[], []], self.x = $a[0], self.y = $a[1], $a;
        self.aep = [];
        $a = [[], [], [], []], self.w = $a[0], self.h = $a[1], self.wX = $a[2], self.hY = $a[3], $a;
        self.style = $hash2(["fp", "sp", "fl", "sl", "fr", "sr"], {"fp": "#FFF", "sp": "#000000", "fl": "#FFF", "sl": "#000000", "fr": "rgba(100,100,255,0.8)", "sr": "#000000"});
        self.$setMLevel(3, "set");
        return self.$setN(1);
      }, TMP_106.$$arity = -1);

      Opal.defn(self, '$reset', TMP_108 = function $$reset(curs) {
        var $a, $b, $c, TMP_107, self = this;

        if (curs == null) {
          curs = [0];
        }
        if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          curs['$<<'](1)};
        (($a = [(function() {if ((($c = self.transf) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
          return ["curve0", "curve1"]
          } else {
          return ["curve0"]
        }; return nil; })()]), $b = self.graphExp, $b['$active='].apply($b, $a), $a[$a.length-1]);
        self.graphExp.$update();
        self.plotExp.$update();
        ($a = ($b = curs).$each, $a.$$p = (TMP_107 = function(cur){var self = TMP_107.$$s || this;
          if (self.hist == null) self.hist = nil;
          if (self.exp == null) self.exp = nil;
if (cur == null) cur = nil;
        self.hist['$[]'](cur).$reset();
          self.exp['$[]'](cur).$draw();
          self.hist['$[]'](cur).$drawCurve();
          return self.hist['$[]'](cur).$draw();}, TMP_107.$$s = self, TMP_107.$$arity = 1, TMP_107), $a).call($b);
        self.plotHist.$update();
        self.$setCurHist((function() {if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return 1
          } else {
          return 0
        }; return nil; })());
        self.$setTCL();
        self.$updateTCL(false);
        return self.$updateVisible();
      }, TMP_108.$$arity = -1);

      Opal.defn(self, '$setTCL', TMP_109 = function $$setTCL() {
        var $a, $b, self = this, $case = nil;

        if ((($a = self.checkTCL) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.checkTCL = $scope.get('Curve').$new();
          (($a = [$hash2(["close", "stroke", "fill", "thickness"], {"close": true, "stroke": "#000", "fill": "rgba(100,200,255,0.5)", "thickness": 5})]), $b = self.checkTCL, $b['$style='].apply($b, $a), $a[$a.length-1]);
          self.plotHist.$addChild(self.checkTCL);
        };
        if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return (function() {$case = self.transf['$[]']("name");if ("mean"['$===']($case)) {return self.checkTCL.$setDistrib("normal", [self.exp['$[]'](0).$distrib().$mean(), Math.sqrt($rb_divide(self.exp['$[]'](0).$distrib().$variance(), self.n))])}else if ("stdMean"['$===']($case)) {return self.checkTCL.$setDistrib("normal", [0, 1])}else if ("sum"['$===']($case)) {return self.checkTCL.$setDistrib("normal", [$rb_times(self.exp['$[]'](0).$distrib().$mean(), self.n), Math.sqrt($rb_times(self.exp['$[]'](0).$distrib().$variance(), self.n))])}else { return nil }})()
          } else {
          return nil
        };
      }, TMP_109.$$arity = 0);

      Opal.defn(self, '$updateTCL', TMP_110 = function $$updateTCL(state) {
        var $a, $b, self = this;

        if (state == null) {
          state = true;
        }
        if ((($a = ($b = self.transf, $b !== false && $b !== nil && $b != null ?(["mean", "sum", "stdMean"]['$include?'](self.transf['$[]']("name"))) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          state = false
        };
        if (state !== false && state !== nil && state != null) {
          self.$setTCL();
          self.checkTCL.$draw();};
        return self.checkTCL.shape.visible=state;
      }, TMP_110.$$arity = -1);

      Opal.defn(self, '$setDistrib', TMP_111 = function $$setDistrib(name, params, cur) {
        var $a, $b, self = this, to_set = nil, $case = nil;

        if (name == null) {
          name = "normal";
        }
        if (params == null) {
          params = nil;
        }
        if (cur == null) {
          cur = 0;
        }
        to_set = true;
        $case = name;if ("discreteUniform"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [1, 6, 1]
        }}else if ("bernoulli"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [0.15]
        }}else if ("binomial"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [5, 0.15]
        }}else if ("birthday"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [365, 50]
        }}else if ("uniform"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [0, 1]
        }}else if ("stdNormal"['$===']($case)) {name = "normal";
        if (params !== false && params !== nil && params != null) {
          } else {
          params = [0, 1]
        };}else if ("normal"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [2, 0.5]
        }}else if ("t"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [10]
        }}else if ("chi2"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [10]
        }}else if ("exp"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [1]
        }}else if ("cauchy"['$===']($case)) {if (params !== false && params !== nil && params != null) {
          } else {
          params = [0, 1]
        }}else if ("saljus"['$===']($case)) {self.$setDistribAs($scope.get('Distribution').$new("exp", [1], $hash2(["name", "args"], {"name": "locationScale", "args": [90, 10]})));
        to_set = false;};
        if (to_set !== false && to_set !== nil && to_set != null) {
          self.exp['$[]'](cur).$setDistrib(name, params)};
        if ((($a = ($b = self.transf, $b !== false && $b !== nil && $b != null ?cur['$=='](0) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.$setTransf(self.transf['$[]']("name"))
          } else {
          return nil
        };
      }, TMP_111.$$arity = -1);

      Opal.defn(self, '$setDistribAs', TMP_112 = function $$setDistribAs(dist, cur) {
        var self = this;

        if (cur == null) {
          cur = 0;
        }
        return self.exp['$[]'](cur).$setDistribAs(dist);
      }, TMP_112.$$arity = -2);

      Opal.defn(self, '$setTransfDistrib', TMP_113 = function $$setTransfDistrib(dist, transf, cur) {
        var self = this;

        if (cur == null) {
          cur = 0;
        }
        return self.exp['$[]'](cur).$setDistribAsTransf(transf, dist);
      }, TMP_113.$$arity = -3);

      Opal.defn(self, '$addXY', TMP_114 = function $$addXY(n, cur) {
        var $a, self = this, xy = nil;

        if (n == null) {
          n = 1;
        }
        if (cur == null) {
          cur = 0;
        }
        xy = self.exp['$[]'](cur).$xy(n);
        return $a = [xy['$[]']("x"), xy['$[]']("y")], self.x['$[]='](cur, $a[0]), self.y['$[]='](cur, $a[1]), $a;
      }, TMP_114.$$arity = -1);

      Opal.defn(self, '$setN', TMP_115 = function $$setN(n) {
        var $a, self = this;

        self.n = n;
        if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.$setTransf(self.transf['$[]']("name"))};
        return self.$setNbSim();
      }, TMP_115.$$arity = 1);

      Opal.defn(self, '$setStatMode', TMP_116 = function $$setStatMode(transf) {
        var self = this;

        self.statMode = ((function() {if (transf['$==']("meanIC")) {
          return "ic"
          } else {
          return "none"
        }; return nil; })());
        return self['$isModeHidden?']();
      }, TMP_116.$$arity = 1);

      Opal.defn(self, '$setAlpha', TMP_117 = function $$setAlpha(alpha) {
        var self = this;

        return self.alpha = alpha;
      }, TMP_117.$$arity = 1);

      Opal.defn(self, '$setMLevel', TMP_118 = function $$setMLevel(val, mode) {
        var $a, $b, self = this;

        if (val == null) {
          val = 3;
        }
        if (mode == null) {
          mode = "inc";
        }
        if ((($a = (($b = mode['$==']("inc")) ? val['$=='](0) : mode['$==']("inc"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.mLevel};
        if ((($a = self.mLevels) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.mLevels = [1, 3, 5, 10, 30, 100, 1000, 3000]
        };
        self.mLevel = $rb_plus(((function() {if (mode['$==']("inc")) {
          return self.mLevel
          } else {
          return 0
        }; return nil; })()), val);
        if ((($a = $rb_lt(self.mLevel, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.mLevel = 0};
        if ((($a = $rb_gt(self.mLevel, $rb_minus(self.mLevels.$length(), 1))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.mLevel = $rb_minus(self.mLevels.$length(), 1)};
        return self.$setNbSim();
      }, TMP_118.$$arity = -1);

      Opal.defn(self, '$setNbSim', TMP_119 = function $$setNbSim() {
        var self = this;

        return self.nbSim = [$rb_times(self.n, self.mLevels['$[]'](self.mLevel)), cqlsAEP.m.nbSimMax].$min();
      }, TMP_119.$$arity = 0);

      Opal.defn(self, '$setTransf', TMP_120 = function $$setTransf(transf) {
        var $a, self = this, dist0 = nil, $case = nil, name = nil, params = nil;

        if (transf == null) {
          transf = nil;
        }
        self.transf = transf;
        if (self.transf['$==']("none")) {
          self.transf = nil};
        if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if (self.n['$=='](1)) {
            if ((($a = self.nold) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              } else {
              self.nold = 10
            };
            self.n = self.nold;
            self.$setNbSim();};
          if ((($a = self.transfList) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            } else {
            self.$initTransfList()
          };
          self.transf = self.transfList['$[]'](transf);
          self.transf['$[]=']("name", transf);
          self.transf['$[]=']("origDist", dist0 = self.exp['$[]'](0).$distrib());
          return (function() {$case = self.transf['$[]']("name");if ("sum"['$===']($case)) {self.transf['$[]=']("args", [self.n]);
          if (self.exp['$[]'](0).$distrib().$name()['$==']("bernoulli")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib("binomial", [self.n, dist0.$mean()], 1);
          } else if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib(name = "normal", params = [$rb_times(self.n, dist0.$mean()), Math.sqrt($rb_times(dist0.$variance(), self.n))], 1);
          } else if (dist0.$type()['$==']("disc")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          } else if ((($a = $rb_ge(self.n, 30)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            self.transf['$[]=']("dist", "approx");
            return self.$setDistrib(name = "normal", params = [$rb_times(self.n, dist0.$mean()), Math.sqrt($rb_times(dist0.$variance(), self.n))], 1);
            } else {
            self.transf['$[]=']("dist", "xylim");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          };}else if ("mean"['$===']($case)) {self.transf['$[]=']("args", [self.n]);
          if (self.exp['$[]'](0).$distrib().$name()['$==']("bernoulli")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistribAs($scope.get('Distribution').$new("binomial", [self.n, dist0.$mean()], $hash2(["name", "args"], {"name": "locationScale", "args": [0, $rb_divide(1, self.n)]})), 1);
          } else if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib(name = "normal", params = [dist0.$mean(), Math.sqrt($rb_divide(dist0.$variance(), self.n))], 1);
          } else if (self.exp['$[]'](0).$distrib().$name()['$==']("cauchy")) {
            self.transf['$[]=']("dist", "exact2");
            return self.$setDistrib(name = "cauchy", params = [0, 1], 1);
          } else if (dist0.$type()['$==']("disc")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          } else if ((($a = $rb_ge(self.n, 30)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            self.transf['$[]=']("dist", "approx");
            return self.$setDistrib(name = "normal", params = [dist0.$mean(), Math.sqrt($rb_divide(dist0.$variance(), self.n))], 1);
            } else {
            self.transf['$[]=']("dist", "xylim");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          };}else if ("stdMean"['$===']($case)) {self.transf['$[]=']("args", [dist0.$mean()]);
          if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib(name = "t", params = [$rb_minus(self.n, 1)], 1);
          } else if ((($a = $rb_ge(self.n, 30)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            self.transf['$[]=']("dist", "approx");
            return self.$setDistrib(name = "normal", params = [0, 1], 1);
            } else {
            self.transf['$[]=']("dist", "xylim");
            return self.$setDistrib(name = "normal", params = [0, 1], 1);
          };}else if ("sumOfSq"['$===']($case)) {self.transf['$[]=']("args", [self.n]);
          self.transf['$[]=']("dist", "exact2");
          if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            return self.$setDistrib("chi2", [self.n], 1)
            } else {
            return self.$setTransfDistrib(dist0, self.transf, 1)
          };}else if ("locationScale"['$===']($case)) {$a = [self.n, 1], self.nold = $a[0], self.n = $a[1], $a;
          self.transf['$[]=']("dist", "exact");
          self.transf['$[]=']("args", [$rb_divide(dist0.$mean()['$-@'](), Math.sqrt(dist0.$variance())), $rb_divide(1, Math.sqrt(dist0.$variance()))]);
          return self.$setTransfDistrib(dist0, self.transf, 1);}else if ("square"['$===']($case)) {$a = [self.n, 1], self.nold = $a[0], self.n = $a[1], $a;
          self.transf['$[]=']("dist", "exact");
          self.transf['$[]=']("args", []);
          return self.$setTransfDistrib(dist0, self.transf, 1);}else if ("center"['$===']($case)) {$a = [self.n, 1], self.nold = $a[0], self.n = $a[1], $a;
          self.transf['$[]=']("dist", "exact");
          self.transf['$[]=']("transf", "locationScale");
          self.transf['$[]=']("args", [dist0.$mean()['$-@'](), 1]);
          return self.$setTransfDistrib(dist0, $hash2(["name", "args"], {"name": self.transf['$[]']("transf"), "args": self.transf['$[]']("args")}), 1);}else { return nil }})();
          } else {
          self.nold = self.n;
          return self.n = 1;
        };
      }, TMP_120.$$arity = -1);

      Opal.defn(self, '$animMode', TMP_121 = function $$animMode() {
        var $a, self = this;

        cqlsAEP.i.anim=cqlsAEP.f.getValue("animMode");
        cqlsAEP.i.prior=cqlsAEP.f.getValue("priorMode");
        if ((($a = cqlsAEP.i.anim) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = cqlsAEP.i.prior) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return "prior"
            } else {
            return "normal"
          }
          } else {
          return "fast"
        };
      }, TMP_121.$$arity = 0);

      Opal.defn(self, '$transfMode', TMP_122 = function $$transfMode() {
        var $a, self = this;

        if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.transf['$[]']("mode")
          } else {
          return "none"
        };
      }, TMP_122.$$arity = 0);

      Opal.defn(self, '$initTransfList', TMP_123 = function $$initTransfList() {
        var self = this;

        return self.transfList = $hash2(["sum", "mean", "stdMean", "sumOfSq", "locationScale", "square", "addition", "center"], {"sum": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "mean": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "stdMean": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "sumOfSq": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "locationScale": $hash2(["args", "mode"], {"args": [], "mode": "all"}), "square": $hash2(["args", "mode"], {"args": [], "mode": "all"}), "addition": $hash2(["args", "mode"], {"args": [], "mode": "all"}), "center": $hash2(["args", "mode"], {"args": [], "mode": "all"})});
      }, TMP_123.$$arity = 0);

      Opal.defn(self, '$applyTransfByValue', TMP_124 = function $$applyTransfByValue(v) {
        var $a, $b, self = this;

        return ($a = self.$method($rb_plus((((($b = self.transf['$[]']("transf")) !== false && $b !== nil && $b != null) ? $b : self.transf['$[]']("name"))), "_transf"))).$call.apply($a, [v].concat(Opal.to_a(self.transf['$[]']("args"))));
      }, TMP_124.$$arity = 1);

      Opal.defn(self, '$applyTransfByIndex', TMP_125 = function $$applyTransfByIndex(inds, v) {
        var $a, $b, self = this;

        return ($a = self.$method($rb_plus((((($b = self.transf['$[]']("transf")) !== false && $b !== nil && $b != null) ? $b : self.transf['$[]']("name"))), "_transf_by_index"))).$call.apply($a, [inds, v].concat(Opal.to_a(self.transf['$[]']("args"))));
      }, TMP_125.$$arity = 2);

      Opal.defn(self, '$sum_transf', TMP_127 = function $$sum_transf(v) {
        var $a, $b, TMP_126, self = this;

        return ($a = ($b = v).$inject, $a.$$p = (TMP_126 = function(e, v2){var self = TMP_126.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, v2)}, TMP_126.$$s = self, TMP_126.$$arity = 2, TMP_126), $a).call($b, 0);
      }, TMP_127.$$arity = 1);

      Opal.defn(self, '$sum_transf_by_index', TMP_129 = function $$sum_transf_by_index(inds, v) {
        var $a, $b, TMP_128, self = this;

        return ($a = ($b = inds).$inject, $a.$$p = (TMP_128 = function(e, i){var self = TMP_128.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, v['$[]'](i))}, TMP_128.$$s = self, TMP_128.$$arity = 2, TMP_128), $a).call($b, 0);
      }, TMP_129.$$arity = 2);

      Opal.defn(self, '$mean_transf', TMP_131 = function $$mean_transf(v) {
        var $a, $b, TMP_130, self = this;

        return $rb_divide((($a = ($b = v).$inject, $a.$$p = (TMP_130 = function(e, v2){var self = TMP_130.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, v2)}, TMP_130.$$s = self, TMP_130.$$arity = 2, TMP_130), $a).call($b, 0)), self.n);
      }, TMP_131.$$arity = 1);

      Opal.defn(self, '$mean_transf_by_index', TMP_133 = function $$mean_transf_by_index(inds, v) {
        var $a, $b, TMP_132, self = this;

        return $rb_divide((($a = ($b = inds).$inject, $a.$$p = (TMP_132 = function(e, i){var self = TMP_132.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, v['$[]'](i))}, TMP_132.$$s = self, TMP_132.$$arity = 2, TMP_132), $a).call($b, 0)), self.n);
      }, TMP_133.$$arity = 2);

      Opal.defn(self, '$stdMean_transf', TMP_136 = function $$stdMean_transf(v, mu) {
        var $a, $b, TMP_134, $c, TMP_135, self = this, m = nil, m2 = nil;

        m = $rb_divide((($a = ($b = v).$inject, $a.$$p = (TMP_134 = function(e, v2){var self = TMP_134.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, v2)}, TMP_134.$$s = self, TMP_134.$$arity = 2, TMP_134), $a).call($b, 0)), self.n);
        m2 = $rb_divide((($a = ($c = v).$inject, $a.$$p = (TMP_135 = function(e, v2){var self = TMP_135.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, v2['$**'](2))}, TMP_135.$$s = self, TMP_135.$$arity = 2, TMP_135), $a).call($c, 0)), self.n);
        return $rb_divide(($rb_minus(m, mu)), Math.sqrt(($rb_minus(m2, m['$**'](2)))/$rb_minus(self.n, 1)));
      }, TMP_136.$$arity = 2);

      Opal.defn(self, '$stdMean_transf_by_index', TMP_139 = function $$stdMean_transf_by_index(inds, v, mu) {
        var $a, $b, TMP_137, $c, TMP_138, self = this, m = nil, m2 = nil;

        m = $rb_divide((($a = ($b = inds).$inject, $a.$$p = (TMP_137 = function(e, i){var self = TMP_137.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, v['$[]'](i))}, TMP_137.$$s = self, TMP_137.$$arity = 2, TMP_137), $a).call($b, 0)), self.n);
        m2 = $rb_divide(($a = ($c = inds).$inject, $a.$$p = (TMP_138 = function(e, i){var self = TMP_138.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, v['$[]'](i)['$**'](2))}, TMP_138.$$s = self, TMP_138.$$arity = 2, TMP_138), $a).call($c, 0), self.n);
        return $rb_divide(($rb_minus(m, mu)), Math.sqrt(($rb_minus(m2, m['$**'](2)))/$rb_minus(self.n, 1)));
      }, TMP_139.$$arity = 3);

      Opal.defn(self, '$sumOfSq_transf', TMP_141 = function $$sumOfSq_transf(v) {
        var $a, $b, TMP_140, self = this, m = nil, s = nil;

        $a = [self.transf['$[]']("origDist").$mean(), self.transf['$[]']("origDist").$stdDev()], m = $a[0], s = $a[1], $a;
        return ($a = ($b = v).$inject, $a.$$p = (TMP_140 = function(e, v2){var self = TMP_140.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, ($rb_divide(($rb_minus(v2, m)), s))['$**'](2))}, TMP_140.$$s = self, TMP_140.$$arity = 2, TMP_140), $a).call($b, 0);
      }, TMP_141.$$arity = 1);

      Opal.defn(self, '$sumOfSq_transf_by_index', TMP_143 = function $$sumOfSq_transf_by_index(inds, v) {
        var $a, $b, TMP_142, self = this, m = nil, s = nil;

        $a = [self.transf['$[]']("origDist").$mean(), self.transf['$[]']("origDist").$stdDev()], m = $a[0], s = $a[1], $a;
        return ($a = ($b = inds).$inject, $a.$$p = (TMP_142 = function(e, i){var self = TMP_142.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, ($rb_divide(($rb_minus(v['$[]'](i), m)), s))['$**'](2))}, TMP_142.$$s = self, TMP_142.$$arity = 2, TMP_142), $a).call($b, 0);
      }, TMP_143.$$arity = 2);

      Opal.defn(self, '$seMean_transf', TMP_146 = function $$seMean_transf(v) {
        var $a, $b, TMP_144, $c, TMP_145, self = this, m = nil, m2 = nil;

        m = $rb_divide((($a = ($b = v).$inject, $a.$$p = (TMP_144 = function(e, v2){var self = TMP_144.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, v2)}, TMP_144.$$s = self, TMP_144.$$arity = 2, TMP_144), $a).call($b, 0)), self.n);
        m2 = $rb_divide((($a = ($c = v).$inject, $a.$$p = (TMP_145 = function(e, v2){var self = TMP_145.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = $rb_plus(e, v2['$**'](2))}, TMP_145.$$s = self, TMP_145.$$arity = 2, TMP_145), $a).call($c, 0)), self.n);
        return Math.sqrt(($rb_minus(m2, m['$**'](2)))/$rb_minus(self.n, 1));
      }, TMP_146.$$arity = 1);

      Opal.defn(self, '$seMean_transf_by_index', TMP_149 = function $$seMean_transf_by_index(inds, v) {
        var $a, $b, TMP_147, $c, TMP_148, self = this, m = nil, m2 = nil;

        m = $rb_divide((($a = ($b = inds).$inject, $a.$$p = (TMP_147 = function(e, i){var self = TMP_147.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, v['$[]'](i))}, TMP_147.$$s = self, TMP_147.$$arity = 2, TMP_147), $a).call($b, 0)), self.n);
        m2 = $rb_divide((($a = ($c = inds).$inject, $a.$$p = (TMP_148 = function(e, i){var self = TMP_148.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = $rb_plus(e, v['$[]'](i)['$**'](2))}, TMP_148.$$s = self, TMP_148.$$arity = 2, TMP_148), $a).call($c, 0)), self.n);
        return Math.sqrt(($rb_minus(m2, m['$**'](2)))/$rb_minus(self.n, 1));
      }, TMP_149.$$arity = 2);

      Opal.defn(self, '$locationScale_transf', TMP_151 = function $$locationScale_transf(v) {
        var $a, $b, TMP_150, self = this;

        return ($a = ($b = v).$map, $a.$$p = (TMP_150 = function(e){var self = TMP_150.$$s || this;
          if (self.transf == null) self.transf = nil;
if (e == null) e = nil;
        return $rb_plus(self.transf['$[]']("args")['$[]'](0), $rb_times(e, self.transf['$[]']("args")['$[]'](1)))}, TMP_150.$$s = self, TMP_150.$$arity = 1, TMP_150), $a).call($b);
      }, TMP_151.$$arity = 1);

      Opal.defn(self, '$locationScale_transf_by_index', TMP_153 = function $$locationScale_transf_by_index(inds, v) {
        var $a, $b, TMP_152, self = this;

        return ($a = ($b = inds).$map, $a.$$p = (TMP_152 = function(i){var self = TMP_152.$$s || this;
          if (self.transf == null) self.transf = nil;
if (i == null) i = nil;
        return $rb_plus(self.transf['$[]']("args")['$[]'](0), $rb_times(v['$[]'](i), self.transf['$[]']("args")['$[]'](1)))}, TMP_152.$$s = self, TMP_152.$$arity = 1, TMP_152), $a).call($b);
      }, TMP_153.$$arity = 2);

      Opal.defn(self, '$square_transf', TMP_155 = function $$square_transf(v) {
        var $a, $b, TMP_154, self = this;

        return ($a = ($b = v).$map, $a.$$p = (TMP_154 = function(e){var self = TMP_154.$$s || this;
if (e == null) e = nil;
        return e['$**'](2)}, TMP_154.$$s = self, TMP_154.$$arity = 1, TMP_154), $a).call($b);
      }, TMP_155.$$arity = 1);

      Opal.defn(self, '$square_transf_by_index', TMP_157 = function $$square_transf_by_index(inds, v) {
        var $a, $b, TMP_156, self = this;

        return ($a = ($b = inds).$map, $a.$$p = (TMP_156 = function(i){var self = TMP_156.$$s || this;
if (i == null) i = nil;
        return v['$[]'](i)['$**'](2)}, TMP_156.$$s = self, TMP_156.$$arity = 1, TMP_156), $a).call($b);
      }, TMP_157.$$arity = 2);

      Opal.defn(self, '$setCurHist', TMP_158 = function $$setCurHist(ind) {
        var self = this;

        if (ind == null) {
          ind = 0;
        }
        self.curIndHist = ind;
        self.histCur = self.hist['$[]'](self.curIndHist);
        return self.expCur = self.exp['$[]'](self.curIndHist);
      }, TMP_158.$$arity = -1);

      Opal.defn(self, '$drawHist', TMP_159 = function $$drawHist() {
        var self = this;

        return nil;
      }, TMP_159.$$arity = 0);

      Opal.defn(self, '$allowLevelChange', TMP_160 = function $$allowLevelChange(state) {
        var self = this;

        cqlsAEP.i.allowLevelChange=state;
        if (state !== false && state !== nil && state != null) {
          return self.histCur.$acceptLevelNext()
          } else {
          return nil
        };
      }, TMP_160.$$arity = 1);

      Opal.defn(self, '$transitionInitTransf', TMP_168 = function $$transitionInitTransf(o, t) {
        var $a, $b, TMP_161, $c, TMP_162, $d, TMP_163, $e, TMP_164, $f, TMP_165, $g, TMP_166, $h, TMP_167, self = this, q = nil, mu = nil, opdf = nil, tpdf = nil;

        if (o == null) {
          o = 0;
        }
        if (t == null) {
          t = 1;
        }
        if (self.$transfMode()['$==']("sample")) {
          self.ind = [];
          ($a = ($b = ($range(0, ($rb_divide(self.x['$[]'](o).$length(), self.n)), true))).$each, $a.$$p = (TMP_161 = function(i){var self = TMP_161.$$s || this;
            if (self.ind == null) self.ind = nil;
if (i == null) i = nil;
          return self.ind['$<<']([])}, TMP_161.$$s = self, TMP_161.$$arity = 1, TMP_161), $a).call($b);
          ($a = ($c = ($range(0, self.x['$[]'](o).$length(), true))).$each, $a.$$p = (TMP_162 = function(i){var self = TMP_162.$$s || this;
            if (self.ind == null) self.ind = nil;
            if (self.n == null) self.n = nil;
if (i == null) i = nil;
          return self.ind['$[]'](($rb_divide(i, self.n)).$floor())['$<<'](i)}, TMP_162.$$s = self, TMP_162.$$arity = 1, TMP_162), $a).call($c);
          self.x['$[]='](t, $rb_times([0], ($rb_divide(self.x['$[]'](o).$length(), self.n))));
          if (self.statMode['$==']("ic")) {
            $a = [$rb_times([0], (self.x['$[]'](t).$length())), $rb_times([0], (self.x['$[]'](t).$length())), 0, self.n01.$quantile($rb_minus(1, $rb_divide(self.alpha, 2))), self.exp['$[]'](t).$distrib().$mean()], self.icSide = $a[0], self.icGood = $a[1], self.cptIC = $a[2], q = $a[3], mu = $a[4], $a};
          self.col = [];
          ($a = ($d = self.ind).$each_with_index, $a.$$p = (TMP_163 = function(s, i){var self = TMP_163.$$s || this, $e, $f;
            if (self.x == null) self.x = nil;
            if (self.col == null) self.col = nil;
            if (self.statMode == null) self.statMode = nil;
            if (self.icSide == null) self.icSide = nil;
            if (self.icGood == null) self.icGood = nil;
            if (self.cptIC == null) self.cptIC = nil;
if (s == null) s = nil;if (i == null) i = nil;
          self.x['$[]'](t)['$[]='](i, self.$applyTransfByIndex(s, self.x['$[]'](o)));
            self.col['$[]='](i, [(Math.random()*256).$floor(), (Math.random()*256).$floor(), (Math.random()*256).$floor(), 0.8]);
            if (self.statMode['$==']("ic")) {
              self.icSide['$[]='](i, $rb_times(q, self.$seMean_transf_by_index(s, self.x['$[]'](o))));
              if ((($e = ($f = ($rb_le($rb_minus(self.x['$[]'](t)['$[]'](i), self.icSide['$[]'](i)), mu)), $f !== false && $f !== nil && $f != null ?($rb_le(mu, $rb_plus(self.x['$[]'](t)['$[]'](i), self.icSide['$[]'](i)))) : $f)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
                self.icGood['$[]='](i, 1)};
              return self.cptIC = $rb_plus(self.cptIC, self.icGood['$[]'](i));
              } else {
              return nil
            };}, TMP_163.$$s = self, TMP_163.$$arity = 2, TMP_163), $a).call($d);
          return self.y['$[]='](t, self.exp['$[]'](t).$y(self.x['$[]'](t)));
        } else if (self.$transfMode()['$==']("all")) {
          self.ind = ($a = ($e = ($range(0, self.x['$[]'](o).$length(), true))).$map, $a.$$p = (TMP_164 = function(i){var self = TMP_164.$$s || this;
if (i == null) i = nil;
          return [i]}, TMP_164.$$s = self, TMP_164.$$arity = 1, TMP_164), $a).call($e);
          self.x['$[]='](t, self.$applyTransfByValue(self.x['$[]'](o)));
          self.col = $rb_times([[0, 0, 0, 1]], (self.x['$[]'](t).$length()));
          self.y['$[]='](t, self.exp['$[]'](t).$y(self.x['$[]'](t)));
          opdf = ($a = ($f = self.exp['$[]'](o).$distrib().$pdf(self.x['$[]'](o))).$map, $a.$$p = (TMP_165 = function(e){var self = TMP_165.$$s || this;
            if (self.exp == null) self.exp = nil;
if (e == null) e = nil;
          return $rb_divide(e, self.exp['$[]'](o).$distrib().$step())}, TMP_165.$$s = self, TMP_165.$$arity = 1, TMP_165), $a).call($f);
          tpdf = ($a = ($g = self.exp['$[]'](t).$distrib().$pdf(self.x['$[]'](t))).$map, $a.$$p = (TMP_166 = function(e){var self = TMP_166.$$s || this;
            if (self.exp == null) self.exp = nil;
if (e == null) e = nil;
          return $rb_divide(e, self.exp['$[]'](t).$distrib().$step())}, TMP_166.$$s = self, TMP_166.$$arity = 1, TMP_166), $a).call($g);
          return self.y['$[]='](t, ($a = ($h = ($range(0, self.x['$[]'](o).$length(), true))).$map, $a.$$p = (TMP_167 = function(i){var self = TMP_167.$$s || this;
            if (self.y == null) self.y = nil;
if (i == null) i = nil;
          return $rb_times($rb_divide((self.y['$[]'](o)['$[]'](i)), opdf['$[]'](i)), tpdf['$[]'](i))}, TMP_167.$$s = self, TMP_167.$$arity = 1, TMP_167), $a).call($h));
          } else {
          return nil
        };
      }, TMP_168.$$arity = -1);

      Opal.defn(self, '$transitionInitHist', TMP_169 = function $$transitionInitHist(cur, mode) {
        var $a, self = this;

        if (mode == null) {
          mode = "normal";
        }
        self.$allowLevelChange(false);
        self.hist['$[]'](cur).$updateHistAEP(self.x['$[]'](cur), mode);
        self.aep['$[]='](cur, self.hist['$[]'](cur).$aep());
        $a = [self.aep['$[]'](cur)['$[]']("step"), $rb_divide($rb_divide(1, self.aep['$[]'](cur)['$[]']("nbTot").$to_f()), self.aep['$[]'](cur)['$[]']("step"))], self.w['$[]='](cur, $a[0]), self.h['$[]='](cur, $a[1]), $a;
        return $a = [$rb_minus(self.graphHist.$to_X(self.w['$[]'](cur)), self.graphHist.$to_X(0)), $rb_minus(self.graphHist.$to_Y(0), self.graphHist.$to_Y(self.h['$[]'](cur)))], self.wX['$[]='](cur, $a[0]), self.hY['$[]='](cur, $a[1]), $a;
      }, TMP_169.$$arity = -2);

      Opal.defn(self, '$transitionInitPts', TMP_171 = function $$transitionInitPts(cur) {
        var $a, $b, TMP_170, self = this;

        return ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_170 = function(i){var self = TMP_170.$$s || this;
          if (self.style == null) self.style = nil;
          if (self.hist == null) self.hist = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        
					//draw points
					cqlsAEP.actors.pt[i].graphics.c().s(self.style['$[]']("sp")).f(self.style['$[]']("fp")).drawCircle(0,0,cqlsAEP.i.ptSize);
					//tweens for points
					cqlsAEP.tweens.pt[i]=createjs.Tween.get(cqlsAEP.actors.pt[i],{override:true});
				;
          if (self.hist['$[]'](cur).$type()['$==']("disc")) {
            
						//draw lines
						cqlsAEP.actors.line[i].graphics.c().s(self.style['$[]']("sl")).f(self.style['$[]']("fl"))
						.drawRect(0,0,self.wX['$[]'](cur),0);
						cqlsAEP.actors.line[i].regX=self.wX['$[]'](cur)/2.0;
						//tweens for lines
						cqlsAEP.tweens.line[i]=createjs.Tween.get(cqlsAEP.actors.line[i],{override:true});
					;
            } else {
            return nil
          };}, TMP_170.$$s = self, TMP_170.$$arity = 1, TMP_170), $a).call($b);
      }, TMP_171.$$arity = 1);

      Opal.defn(self, '$transitionInitPtsTransf', TMP_175 = function $$transitionInitPtsTransf(cur) {
        var $a, $b, TMP_172, $c, TMP_174, self = this;

        if (self.transf['$[]']("mode")['$==']("sample")) {
          } else {
          return nil
        };
        if (cur['$=='](0)) {
          return ($a = ($b = self.ind).$each_with_index, $a.$$p = (TMP_172 = function(s, i2){var self = TMP_172.$$s || this, $c, $d, TMP_173, col = nil;
            if (self.col == null) self.col = nil;
if (s == null) s = nil;if (i2 == null) i2 = nil;
          col = "rgba(" + (self.col['$[]'](i2)['$[]'](0)) + "," + (self.col['$[]'](i2)['$[]'](1)) + "," + (self.col['$[]'](i2)['$[]'](2)) + "," + (self.col['$[]'](i2)['$[]'](3)) + ")";
            return ($c = ($d = s).$each, $c.$$p = (TMP_173 = function(i){var self = TMP_173.$$s || this;
              if (self.style == null) self.style = nil;
              if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
            
							cqlsAEP.actors.pt[i].graphics.c().s(self.style['$[]']("sp")).f(col).drawCircle(0,0,cqlsAEP.i.ptSize);
							cqlsAEP.actors.line[i].graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](cur),2);
						;}, TMP_173.$$s = self, TMP_173.$$arity = 1, TMP_173), $c).call($d);}, TMP_172.$$s = self, TMP_172.$$arity = 2, TMP_172), $a).call($b)
          } else {
          return ($a = ($c = ($range(0, self.x['$[]'](cur).$length(), true))).$each_with_index, $a.$$p = (TMP_174 = function(i){var self = TMP_174.$$s || this, col = nil;
            if (self.col == null) self.col = nil;
            if (self.style == null) self.style = nil;
            if (self.hist == null) self.hist = nil;
            if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
          col = "rgba(" + (self.col['$[]'](i)['$[]'](0)) + "," + (self.col['$[]'](i)['$[]'](1)) + "," + (self.col['$[]'](i)['$[]'](2)) + "," + (self.col['$[]'](i)['$[]'](3)) + ")";
            
						cqlsAEP.actors.pt[i].graphics.c().s(self.style['$[]']("sp")).f(col).drawCircle(0,0,cqlsAEP.i.ptSize);
					;
            if (self.hist['$[]'](cur).$type()['$==']("disc")) {
              
							//cqlsAEP.actors.line[i].graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](cur),2);
							cqlsAEP.tweens.line[i].call(function(tween) {
					 			tween._target.graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](cur),2);
					 		})
					;
              } else {
              return nil
            };}, TMP_174.$$s = self, TMP_174.$$arity = 1, TMP_174), $a).call($c)
        };
      }, TMP_175.$$arity = 1);

      Opal.defn(self, '$transitionInitTime', TMP_176 = function $$transitionInitTime() {
        var self = this;

        return self.time = 0;
      }, TMP_176.$$arity = 0);

      Opal.defn(self, '$transitionInitExpRects', TMP_178 = function $$transitionInitExpRects(cur) {
        var $a, $b, TMP_177, self = this, scale = nil;

        if ((($a = self.modeHidden) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          scale = $rb_divide(($rb_times(self.graphExp.$dim()['$[]']("h"), 0.2)), (self.x['$[]'](cur).$length()));
          if ((($a = $rb_gt(scale, 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            scale = 1};};
        return ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_177 = function(i){var self = TMP_177.$$s || this, y = nil;
          if (self.yExpAxis == null) self.yExpAxis = nil;
          if (self.hist == null) self.hist = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
          if (self.style == null) self.style = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        y = $rb_minus(self.yExpAxis['$[]'](0), ((function() {if (self.hist['$[]'](cur).$type()['$==']("disc")) {
            return ($rb_times(i, scale))
            } else {
            return 0
          }; return nil; })()));
          
					//draw rect first
					cqlsAEP.actors.rect[i].x=self.graphExp.$to_X(self.aep['$[]'](cur)['$[]']("xRect")['$[]'](i));cqlsAEP.actors.rect[i].y=y;
					cqlsAEP.actors.rect[i].regY=$rb_divide(self.hY['$[]'](cur), 2);
					cqlsAEP.actors.rect[i].graphics.c().f(self.style['$[]']("fr")).s(self.style['$[]']("sr")).drawRect(0,0,self.wX['$[]'](cur),self.hY['$[]'](cur));
					cqlsAEP.tweens.rect[i]=createjs.Tween.get(cqlsAEP.actors.rect[i],{override:true});
				;}, TMP_177.$$s = self, TMP_177.$$arity = 1, TMP_177), $a).call($b);
      }, TMP_178.$$arity = 1);

      Opal.defn(self, '$transitionInitRects', TMP_180 = function $$transitionInitRects(cur) {
        var $a, $b, TMP_179, self = this;

        return ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_179 = function(i){var self = TMP_179.$$s || this;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.aep == null) self.aep = nil;
          if (self.plotHist == null) self.plotHist = nil;
          if (self.hY == null) self.hY = nil;
          if (self.style == null) self.style = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        
					//draw rect first
					cqlsAEP.actors.rect[i].x=self.graphHist.$to_X(self.aep['$[]'](cur)['$[]']("xRect")['$[]'](i));cqlsAEP.actors.rect[i].y=self.plotHist.$dim()['$[]']("y");
					cqlsAEP.actors.rect[i].regY=$rb_divide(self.hY['$[]'](cur), 2);
					cqlsAEP.actors.rect[i].graphics.c().f(self.style['$[]']("fr")).s(self.style['$[]']("sr")).drawRect(0,0,self.wX['$[]'](cur),self.hY['$[]'](cur));
					cqlsAEP.tweens.rect[i]=createjs.Tween.get(cqlsAEP.actors.rect[i],{override:true});
				;}, TMP_179.$$s = self, TMP_179.$$arity = 1, TMP_179), $a).call($b);
      }, TMP_180.$$arity = 1);

      Opal.defn(self, '$transitionDrawPts', TMP_182 = function $$transitionDrawPts(cur, wait) {
        var $a, $b, TMP_181, self = this, scale = nil;

        if (wait == null) {
          wait = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if ((($a = self.modeHidden) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          scale = $rb_divide(($rb_times(self.graphExp.$dim()['$[]']("h"), 0.2)), (self.x['$[]'](cur).$length()));
          if ((($a = $rb_gt(scale, 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            scale = 1};
          if (cur['$=='](0)) {
            self.remember = $hash2(["lag"], {"lag": $rb_divide(wait, self.x['$[]'](cur).$length())})};};
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_181 = function(i){var self = TMP_181.$$s || this, $c, $d, $e, y = nil, wait2 = nil;
          if (self.modeHidden == null) self.modeHidden = nil;
          if (self.yExpAxis == null) self.yExpAxis = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.y == null) self.y = nil;
          if (self.hist == null) self.hist = nil;
          if (self.transf == null) self.transf = nil;
          if (self.remember == null) self.remember = nil;
          if (self.x == null) self.x = nil;
if (i == null) i = nil;
        y = (function() {if ((($c = self.modeHidden) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return self.yExpAxis['$[]'](0)
            } else {
            return self.graphExp.$to_Y(self.y['$[]'](cur)['$[]'](i))
          }; return nil; })();
          if ((($c = ($d = self.modeHidden, $d !== false && $d !== nil && $d != null ?self.hist['$[]'](cur).$type()['$==']("disc") : $d)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            y = $rb_minus(y, $rb_times(i, scale))};
          wait2 = wait;
          if ((($c = ($d = ($e = self.modeHidden, $e !== false && $e !== nil && $e != null ?cur['$=='](0) : $e), $d !== false && $d !== nil && $d != null ?self.transf : $d)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            wait2 = $rb_minus(wait2, $rb_times(i, self.remember['$[]']("lag")))};
          
					cqlsAEP.tweens.pt[i].to({x:self.graphExp.$to_X(self.x['$[]'](cur)['$[]'](i)),y:y})
					.set({visible:true})
					.wait(wait2)
				;
          if ((($c = (($d = self.hist['$[]'](cur).$type()['$==']("disc")) ? self.modeHidden['$!']() : self.hist['$[]'](cur).$type()['$==']("disc"))) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            
						cqlsAEP.tweens.line[i].to({x:self.graphExp.$to_X(self.x['$[]'](cur)['$[]'](i)),y:self.graphExp.$to_Y(self.y['$[]'](cur)['$[]'](i))})
						.set({visible:true})
						.wait(wait);
					;
            } else {
            return nil
          };}, TMP_181.$$s = self, TMP_181.$$arity = 1, TMP_181), $a).call($b);
        return self.time = $rb_plus(self.time, wait);
      }, TMP_182.$$arity = -2);

      Opal.defn(self, '$transitionPtsTransf', TMP_185 = function $$transitionPtsTransf(t, merge, wait) {
        var $a, $b, TMP_183, self = this, scale = nil;

        if (t == null) {
          t = 1;
        }
        if (merge == null) {
          merge = $rb_times(1500, cqlsAEP.i.scaleTime);
        }
        if (wait == null) {
          wait = $rb_times(500, cqlsAEP.i.scaleTime);
        }
        if ((($a = self.modeHidden) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          scale = $rb_divide(($rb_times(self.graphExp.$dim()['$[]']("h"), 0.2)), (self.ind.$length()));
          if ((($a = $rb_gt(scale, 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            scale = 1};};
        ($a = ($b = self.ind).$each_with_index, $a.$$p = (TMP_183 = function(s, i2){var self = TMP_183.$$s || this, $c, $d, TMP_184, col = nil, y = nil;
          if (self.col == null) self.col = nil;
          if (self.modeHidden == null) self.modeHidden = nil;
          if (self.yExpAxis == null) self.yExpAxis = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.y == null) self.y = nil;
          if (self.hist == null) self.hist = nil;
if (s == null) s = nil;if (i2 == null) i2 = nil;
        col = "rgba(" + (self.col['$[]'](i2)['$[]'](0)) + "," + (self.col['$[]'](i2)['$[]'](1)) + "," + (self.col['$[]'](i2)['$[]'](2)) + "," + (self.col['$[]'](i2)['$[]'](3)) + ")";
          y = (function() {if ((($c = self.modeHidden) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return self.yExpAxis['$[]'](1)
            } else {
            return self.graphExp.$to_Y(self.y['$[]'](t)['$[]'](i2))
          }; return nil; })();
          if ((($c = ($d = self.modeHidden, $d !== false && $d !== nil && $d != null ?self.hist['$[]'](t).$type()['$==']("disc") : $d)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            y = $rb_minus(y, $rb_times(i2, scale))};
          return ($c = ($d = s).$each, $c.$$p = (TMP_184 = function(i){var self = TMP_184.$$s || this, $e, $f, $g, wait2 = nil;
            if (self.modeHidden == null) self.modeHidden = nil;
            if (self.n == null) self.n = nil;
            if (self.remember == null) self.remember = nil;
            if (self.graphExp == null) self.graphExp = nil;
            if (self.x == null) self.x = nil;
            if (self.transf == null) self.transf = nil;
            if (self.hist == null) self.hist = nil;
            if (self.wX == null) self.wX = nil;
            if (self.style == null) self.style = nil;
            if (self.y == null) self.y = nil;
if (i == null) i = nil;
          wait2 = wait;
            if ((($e = self.modeHidden) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
              wait2 = $rb_minus(wait2, $rb_times(($rb_minus(self.n, i)), self.remember['$[]']("lag")))};
            
						cqlsAEP.tweens.pt[i].to({x:self.graphExp.$to_X(self.x['$[]'](t)['$[]'](i2)),y:y},merge)
						if(self.modeHidden) cqlsAEP.tweens.pt[i].to({y:self.graphExp.$to_Y(0)},merge)
						cqlsAEP.tweens.pt[i].wait(wait2).set({visible:false})
						if(($e = ($f = ($g = self.transf, $g !== false && $g !== nil && $g != null ?self.hist['$[]'](0).$type()['$==']("disc") : $g), $f !== false && $f !== nil && $f != null ?self.hist['$[]'](1).$type()['$==']("disc") : $f), $e !== false && $e !== nil && $e != null ?self.modeHidden['$!']() : $e)) {
					 		cqlsAEP.tweens.line[i].call(function(tween) {
					 			tween._target.regX=self.wX['$[]'](t)/2.0;
					 			tween._target.graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](t),2);
					 		})
					 		.to({x:self.graphExp.$to_X(self.x['$[]'](t)['$[]'](i2)),y:self.graphExp.$to_Y(self.y['$[]'](t)['$[]'](i2))},merge)
							.wait(wait).set({visible:false})
					 		//cqlsAEP.tweens.line[i].wait($rb_plus(wait, merge)).set({visible:false});
						}
					;}, TMP_184.$$s = self, TMP_184.$$arity = 1, TMP_184), $c).call($d);}, TMP_183.$$s = self, TMP_183.$$arity = 2, TMP_183), $a).call($b);
        self.time = $rb_plus(self.time, $rb_plus(merge, wait));
        if ((($a = self.modeHidden) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.time = $rb_plus(self.time, merge)
          } else {
          return nil
        };
      }, TMP_185.$$arity = -1);

      Opal.defn(self, '$transitionFallPts', TMP_187 = function $$transitionFallPts(cur, fall, wait) {
        var $a, $b, TMP_186, self = this;

        if (fall == null) {
          fall = $rb_times(2000, cqlsAEP.i.scaleTime);
        }
        if (wait == null) {
          wait = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        cqlsAEP.durations.ptsBeforeFall=self.time;
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_186 = function(i){var self = TMP_186.$$s || this;
          if (self.plotHist == null) self.plotHist = nil;
          if (self.hist == null) self.hist = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].to({y:self.plotHist.$dim()['$[]']("y")},fall,createjs.Ease.bounceOut)
					.wait(wait)
				;
          if (self.hist['$[]'](cur).$type()['$==']("disc")) {
            
						cqlsAEP.tweens.line[i].to({y:self.plotHist.$dim()['$[]']("y")},fall,createjs.Ease.bounceOut)
						.wait(wait).set({visible:false});
					;
            } else {
            return nil
          };}, TMP_186.$$s = self, TMP_186.$$arity = 1, TMP_186), $a).call($b);
        return self.time = $rb_plus(self.time, $rb_plus(fall, wait));
      }, TMP_187.$$arity = -2);

      Opal.defn(self, '$transitionExpPtsAndRects', TMP_189 = function $$transitionExpPtsAndRects(cur, from, before, fall, after) {
        var $a, $b, TMP_188, self = this;

        if (from == null) {
          from = self.time;
        }
        if (before == null) {
          before = $rb_times(2000, cqlsAEP.i.scaleTime);
        }
        if (fall == null) {
          fall = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (after == null) {
          after = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        fall = $rb_plus(fall, self.x['$[]'](cur).$length());
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_188 = function(i){var self = TMP_188.$$s || this;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					//rect start here so wait "from" ms first
					cqlsAEP.tweens.rect[i].set({visible:false})
					.wait(from).set({visible:true})
					.wait(before+i)
					.to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

				;}, TMP_188.$$s = self, TMP_188.$$arity = 1, TMP_188), $a).call($b);
        return self.time = $rb_plus(self.time, $rb_plus($rb_plus(before, fall), after));
      }, TMP_189.$$arity = -2);

      Opal.defn(self, '$transitionDrawRectsHidden', TMP_191 = function $$transitionDrawRectsHidden(cur, from, after) {
        var $a, $b, TMP_190, self = this;

        if (from == null) {
          from = self.time;
        }
        if (after == null) {
          after = $rb_times(500, cqlsAEP.i.scaleTime);
        }
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_190 = function(i){var self = TMP_190.$$s || this;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
          if (self.hist == null) self.hist = nil;
          if (self.style == null) self.style = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        

					cqlsAEP.tweens.pt[i].to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0})
					.wait(after);

					if(i==0) {
						cqlsAEP.tweens.rect[i].call(function(tween) {
							self.hist['$[]'](cur).$draw(self.aep['$[]'](cur)['$[]']("nbTot"));
							self.$allowLevelChange(true);
						})
					}
					//redraw rect first
					cqlsAEP.tweens.rect[i].call(function(tween) {
						tween._target.regY=$rb_divide(self.hY['$[]'](cur), 2);
					 	tween._target.graphics.c().f(self.style['$[]']("fr")).s(self.style['$[]']("sr")).drawRect(0,0,self.wX['$[]'](cur),self.hY['$[]'](cur));
					})
					.to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0})
					.wait(after);

				;}, TMP_190.$$s = self, TMP_190.$$arity = 1, TMP_190), $a).call($b);
        return self.time = $rb_plus(self.time, after);
      }, TMP_191.$$arity = -2);

      Opal.defn(self, '$transitionHistPtsAndRectsHidden', TMP_193 = function $$transitionHistPtsAndRectsHidden(cur, from, before, fall, after) {
        var $a, $b, TMP_192, self = this;

        if (from == null) {
          from = self.time;
        }
        if (before == null) {
          before = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (fall == null) {
          fall = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (after == null) {
          after = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        fall = $rb_plus(fall, self.x['$[]'](cur).$length());
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_192 = function(i){var self = TMP_192.$$s || this;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					cqlsAEP.tweens.rect[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

				;}, TMP_192.$$s = self, TMP_192.$$arity = 1, TMP_192), $a).call($b);
        
				//only once
				cqlsAEP.tweens.pt[0].call(function(tween) {
						self.$hideAll(cur)
        self.hist['$[]'](cur).$add(self.x['$[]'](cur))
        self.hist['$[]'](cur).$draw()
        self.$drawSummary(cur);
				})
			;
        return self.time = $rb_plus(self.time, $rb_plus($rb_plus(before, fall), after));
      }, TMP_193.$$arity = -2);

      Opal.defn(self, '$transitionHistPtsAndRects', TMP_195 = function $$transitionHistPtsAndRects(cur, from, before, fall, after) {
        var $a, $b, TMP_194, self = this;

        if (from == null) {
          from = self.time;
        }
        if (before == null) {
          before = $rb_times(2000, cqlsAEP.i.scaleTime);
        }
        if (fall == null) {
          fall = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (after == null) {
          after = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        fall = $rb_plus(fall, self.x['$[]'](cur).$length());
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_194 = function(i){var self = TMP_194.$$s || this;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
          if (self.hist == null) self.hist = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					//rect start here so wait "from" ms first
					cqlsAEP.tweens.rect[i].set({visible:false})
					.wait(from).set({visible:true})
					if(i==0) {
						cqlsAEP.tweens.rect[i].call(function(tween) {
							self.hist['$[]'](cur).$draw(self.aep['$[]'](cur)['$[]']("nbTot"));
							self.$allowLevelChange(true);
						})
					}
					cqlsAEP.tweens.rect[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

				;}, TMP_194.$$s = self, TMP_194.$$arity = 1, TMP_194), $a).call($b);
        
				//only once
				cqlsAEP.tweens.pt[0].call(function(tween) {
						self.$hideAll(cur)
        self.hist['$[]'](cur).$add(self.x['$[]'](cur))
        self.hist['$[]'](cur).$draw()
        self.$drawSummary(cur);
				})
			;
        return self.time = $rb_plus(self.time, $rb_plus($rb_plus(before, fall), after));
      }, TMP_195.$$arity = -2);

      Opal.defn(self, '$transitionDrawIC', TMP_198 = function $$transitionDrawIC(from, wait, pause, before, fall, after) {
        var $a, $b, TMP_196, $c, TMP_197, self = this, cur = nil;

        if (from == null) {
          from = self.time;
        }
        if (wait == null) {
          wait = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (pause == null) {
          pause = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (before == null) {
          before = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (fall == null) {
          fall = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        if (after == null) {
          after = $rb_times(1000, cqlsAEP.i.scaleTime);
        }
        ($a = ($b = self.ind).$each_with_index, $a.$$p = (TMP_196 = function(s, i2){var self = TMP_196.$$s || this, col = nil, y = nil, l = nil;
          if (self.col == null) self.col = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.y == null) self.y = nil;
          if (self.icSide == null) self.icSide = nil;
          if (self.hist == null) self.hist = nil;
          if (self.style == null) self.style = nil;
          if (self.x == null) self.x = nil;
          if (self.icGood == null) self.icGood = nil;
if (s == null) s = nil;if (i2 == null) i2 = nil;
        col = "rgba(" + (self.col['$[]'](i2)['$[]'](0)) + "," + (self.col['$[]'](i2)['$[]'](1)) + "," + (self.col['$[]'](i2)['$[]'](2)) + "," + (self.col['$[]'](i2)['$[]'](3)) + ")";
          y = self.graphExp.$to_Y(self.y['$[]'](1)['$[]'](i2));
          l = $rb_minus(self.graphExp.$to_X(self.icSide['$[]'](i2)), self.graphExp.$to_X(0));
          cqlsAEP.tweens.pt[i2].wait(pause);
          if (self.hist['$[]'](1).$type()['$==']("disc")) {
            
						cqlsAEP.tweens.line[i2]
						.call(function(tween) {
				 			tween._target.regX=l;
				 			tween._target.regY=1;
				 			tween._target.graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,$rb_times(2, l),2);
					 	})
						.wait($rb_times(2, pause))

					;
            } else {
            
						//draw lines
						cqlsAEP.actors.line[i2].graphics.c().s(col).f(self.style['$[]']("fl"))
						.drawRect(0,0,$rb_times(2, l),2);
						cqlsAEP.actors.line[i2].regX=l;
						cqlsAEP.actors.line[i2].regY=1;
						//tweens for lines
						cqlsAEP.tweens.line[i2]=createjs.Tween.get(cqlsAEP.actors.line[i2],{override:true});
						cqlsAEP.tweens.line[i2].set({visible:false}).wait(from+wait)
						.to({x:self.graphExp.$to_X(self.x['$[]'](1)['$[]'](i2)),y:y})
				 		.set({visible:true}).wait(pause)
				 	;
          };
          if (self.icGood['$[]'](i2)['$=='](0)) {
            
						cqlsAEP.tweens.pt[i2].wait(pause).to({scaleX:2.0,scaleY:2.0},pause) //.to({scaleX:1.0,scaleY:1.0})
						cqlsAEP.tweens.line[i2].to({scaleY:3.0},pause).to({scaleY:1.0})
					;
            } else {
            
						cqlsAEP.tweens.pt[i2].wait($rb_times(2, pause))
						cqlsAEP.tweens.line[i2].wait(pause)
					;
          };}, TMP_196.$$s = self, TMP_196.$$arity = 2, TMP_196), $a).call($b);
        self.time = $rb_plus(self.time, $rb_times(3, pause));
        cur = 1;
        fall = $rb_plus(fall, self.x['$[]'](cur).$length());
        ($a = ($c = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_197 = function(i){var self = TMP_197.$$s || this;
          if (self.time == null) self.time = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.y == null) self.y = nil;
          if (self.hist == null) self.hist = nil;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.hY == null) self.hY = nil;
          if (self.icGood == null) self.icGood = nil;
if (i == null) i = nil;
        
					//rect start here so wait "@time" ms first
					cqlsAEP.tweens.rect[i].set({visible:false})
					.wait(self.time)
					.to({x:self.graphExp.$to_X(self.aep['$[]'](cur)['$[]']("xRect")['$[]'](i)),y:self.graphExp.$to_Y(self.y['$[]'](1)['$[]'](i))})
					.set({visible:true})
					if(i==0) {
						cqlsAEP.tweens.rect[i].call(function(tween) {
							self.hist['$[]'](cur).$draw(self.aep['$[]'](cur)['$[]']("nbTot"));
							self.$allowLevelChange(true);
						})
					}

					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);
					cqlsAEP.tweens.line[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					cqlsAEP.tweens.rect[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);
					if(self.icGood['$[]'](i)['$=='](0)) {
						cqlsAEP.tweens.pt[i].to({scaleX:1.0,scaleY:1.0})
						cqlsAEP.tweens.line[i].to({scaleY:1.0})
					}

				;}, TMP_197.$$s = self, TMP_197.$$arity = 1, TMP_197), $a).call($c);
        
				//only once
				cqlsAEP.tweens.pt[0].call(function(tween) {
						self.$hideAll(cur)
        self.hist['$[]'](cur).$add(self.x['$[]'](cur))
        self.hist['$[]'](cur).$incCptIC(self.cptIC)
        self.hist['$[]'](cur).$draw()
        self.$drawSummary(cur);
				})
			;
        return self.time = $rb_plus(self.time, $rb_plus($rb_plus(before, fall), after));
      }, TMP_198.$$arity = -1);

      Opal.defn(self, '$hideAll', TMP_199 = function $$hideAll(cur) {
        var $a, self = this;

        if ((($a = self.x['$[]'](cur)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          
					for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
						cqlsAEP.actors.pt[i].visible=false;
						cqlsAEP.actors.line[i].visible=false;
						cqlsAEP.actors.rect[i].visible=false;
					}
				
          } else {
          return nil
        };
      }, TMP_199.$$arity = 1);

      Opal.defn(self, '$drawSummary', TMP_200 = function $$drawSummary(cur) {
        var self = this, state = nil;

        if (cur == null) {
          cur = self.curIndHist;
        }
        self.hist['$[]'](cur).$drawMean();
        self.hist['$[]'](cur).$drawSD();
        return state = cqlsAEP.f.getValue("checkSummary");
      }, TMP_200.$$arity = -1);

      Opal.defn(self, '$updateVisible', TMP_201 = function $$updateVisible() {
        var self = this, isTransf = nil, isSample = nil, state = nil;

        isTransf = self.$transfMode()['$!=']("none");
        isSample = self.$transfMode()['$==']("sample");
        
				self.exp['$[]'](0).shape.visible=cqlsAEP.f.getValue("checkExp0Curve");
				self.exp['$[]'](1).shape.visible=isTransf & cqlsAEP.f.getValue("checkExp1Curve");
				self.hist['$[]'](0).shape.visible=isTransf['$!']();
				self.hist['$[]'](1).shape.visible=isTransf;
				self.hist['$[]'](0).curveShape.visible=isTransf['$!']() & cqlsAEP.f.getValue("checkHistCurve");
				self.hist['$[]'](1).curveShape.visible=isTransf & cqlsAEP.f.getValue("checkHistCurve");
				self.hist['$[]'](0).summaryShapes[0].visible=false;
				self.hist['$[]'](1).summaryShapes[0].visible=false;
				self.hist['$[]'](0).summaryShapes[1].visible=false;
				self.hist['$[]'](1).summaryShapes[1].visible=false;
				self.checkTCL.shape.visible=isSample & cqlsAEP.f.getValue("checkTCL");
			;
        self.exp['$[]'](0).expAxisShape.visible= !cqlsAEP.f.getValue("checkExp0Curve");
        self.exp['$[]'](1).expAxisShape.visible= false;
        state = cqlsAEP.f.getValue("checkSummary");
        self.exp['$[]'](0).summaryShapes[0].visible=cqlsAEP.f.getValue("checkExp0Mean");
        self.exp['$[]'](0).summaryShapes[1].visible=cqlsAEP.f.getValue("checkExp0SD");
        self.exp['$[]'](1).summaryShapes[0].visible=isTransf & cqlsAEP.f.getValue("checkExp1Mean");
        self.exp['$[]'](1).summaryShapes[1].visible=isTransf & cqlsAEP.f.getValue("checkExp1SD");
        self.histCur.summaryShapes[0].visible=cqlsAEP.f.getValue("checkHistMean");
        self.histCur.summaryShapes[1].visible=cqlsAEP.f.getValue("checkHistSD");
        self.$updateTCL(cqlsAEP.f.getValue("checkTCL"));
        return cqlsAEP.m.stage.update();
      }, TMP_201.$$arity = 0);

      Opal.defn(self, '$playShort', TMP_203 = function $$playShort(cur, duration) {
        var $a, $b, $c, TMP_202, self = this, x = nil, q = nil, mu = nil;

        if (cur == null) {
          cur = self.curIndHist;
        }
        if (duration == null) {
          duration = 500;
        }
        self.$hideAll(cur);
        self.$animMode();
        self.time = 0;
        if ((($a = ($b = self.transf, $b !== false && $b !== nil && $b != null ?(((($c = self.transf['$[]']("dist")['$!=']("exact")) !== false && $c !== nil && $c != null) ? $c : self.statMode['$==']("ic"))) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          x = [];
          if (self.statMode['$==']("ic")) {
            $a = [self.n01.$quantile($rb_minus(1, $rb_divide(self.alpha, 2))), self.exp['$[]'](0).$distrib().$mean()], q = $a[0], mu = $a[1], $a};
          ($a = ($b = ($range(0, ((10)['$**'](cqlsAEP.i.count)), true))).$each, $a.$$p = (TMP_202 = function(i){var self = TMP_202.$$s || this, $d, $e, xx = nil, icSide = nil;
            if (self.exp == null) self.exp = nil;
            if (self.n == null) self.n = nil;
            if (self.statMode == null) self.statMode = nil;
            if (self.hist == null) self.hist = nil;
if (i == null) i = nil;
          xx = self.exp['$[]'](0).$sample(self.n);
            x['$[]='](i, self.$applyTransfByValue(xx));
            if (self.statMode['$==']("ic")) {
              icSide = $rb_times(q, self.$seMean_transf(xx));
              if ((($d = ($e = ($rb_le($rb_minus(x['$[]'](i), icSide), mu)), $e !== false && $e !== nil && $e != null ?($rb_le(mu, $rb_plus(x['$[]'](i), icSide))) : $e)) !== nil && $d != null && (!$d.$$is_boolean || $d == true))) {
                return ($d = self.hist['$[]'](cur), $d['$cptICTot=']($rb_plus($d.$cptICTot(), 1)))
                } else {
                return nil
              };
              } else {
              return nil
            };}, TMP_202.$$s = self, TMP_202.$$arity = 1, TMP_202), $a).call($b);
          self.hist['$[]'](cur).$add(x);
          } else {
          self.hist['$[]'](cur).$add(self.exp['$[]'](cur).$sample((10)['$**'](cqlsAEP.i.count)))
        };
        self.hist['$[]'](cur).$draw();
        self.$drawSummary(cur);
        cqlsAEP.m.stage.update();
        return self.$playNextAfter(duration);
      }, TMP_203.$$arity = -1);

      Opal.defn(self, '$playLongDensityBasic', TMP_204 = function $$playLongDensityBasic(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000;
        }
        self.$addXY(self.nbSim);
        self.$transitionInitHist(0);
        self.$transitionInitPts(0);
        self.$transitionInitRects(0);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionFallPts(0);
        self.$transitionHistPtsAndRects(0);
        return self.$playNextAfter($rb_plus(self.time, duration));
      }, TMP_204.$$arity = -1);

      Opal.defn(self, '$playLongDensityBasicHidden', TMP_205 = function $$playLongDensityBasicHidden(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000;
        }
        self.$addXY(self.nbSim);
        self.$transitionInitHist(0, "new");
        self.$transitionInitPts(0);
        self.$transitionInitExpRects(0);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionExpPtsAndRects(0);
        self.$transitionInitHist(0, "reduced");
        self.$transitionDrawRectsHidden(0);
        self.$transitionInitHist(0);
        self.$transitionHistPtsAndRectsHidden(0);
        return self.$playNextAfter($rb_plus(self.time, duration));
      }, TMP_205.$$arity = -1);

      Opal.defn(self, '$playLongDensityWithTransf', TMP_206 = function $$playLongDensityWithTransf(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000;
        }
        self.$addXY(self.nbSim);
        self.$transitionInitTransf(0, 1);
        self.$transitionInitHist(0);
        self.$transitionInitHist(1);
        self.$transitionInitPts(0);
        self.$transitionInitPtsTransf(0);
        self.$transitionInitRects(1);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionPtsTransf(1);
        self.$transitionInitPtsTransf(1);
        self.$transitionDrawPts(1);
        self.$transitionFallPts(1);
        self.$transitionHistPtsAndRects(1);
        return self.$playNextAfter($rb_plus(self.time, duration));
      }, TMP_206.$$arity = -1);

      Opal.defn(self, '$playLongDensityWithTransfHidden', TMP_207 = function $$playLongDensityWithTransfHidden(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000;
        }
        self.$addXY(self.nbSim);
        self.$transitionInitTransf(0, 1);
        self.$transitionInitHist(0);
        self.$transitionInitHist(1, "new");
        self.$transitionInitPts(0);
        self.$transitionInitPtsTransf(0);
        self.$transitionInitExpRects(1);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionPtsTransf(1);
        self.$transitionInitPtsTransf(1);
        self.$transitionDrawPts(1);
        self.$transitionExpPtsAndRects(1);
        self.$transitionInitHist(1, "reduced");
        self.$transitionDrawRectsHidden(1);
        self.$transitionInitHist(1);
        self.$transitionHistPtsAndRectsHidden(1);
        return self.$playNextAfter($rb_plus(self.time, duration));
      }, TMP_207.$$arity = -1);

      Opal.defn(self, '$playLongDensityForIC', TMP_208 = function $$playLongDensityForIC(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000;
        }
        self.$addXY(self.nbSim);
        self.$transitionInitTransf(0, 1);
        self.$transitionInitHist(0);
        self.$transitionInitHist(1);
        self.$transitionInitPts(0);
        self.$transitionInitPtsTransf(0);
        self.$transitionInitRects(1);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionPtsTransf(1);
        self.$transitionInitPtsTransf(1);
        self.$transitionDrawPts(1);
        self.$transitionDrawIC();
        return self.$playNextAfter($rb_plus(self.time, duration));
      }, TMP_208.$$arity = -1);

      Opal.defn(self, '$isModeHidden?', TMP_209 = function() {
        var self = this;

        self.$animMode();
        self.modeHidden = !cqlsAEP.i.prior;
        if (self.statMode['$==']("ic")) {
          self.modeHidden = false};
        return self.modeHidden;
      }, TMP_209.$$arity = 0);

      Opal.defn(self, '$playLongDensity', TMP_210 = function $$playLongDensity(duration) {
        var $a, self = this;

        if (duration == null) {
          duration = 1000;
        }
        if ((($a = self.transf) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = self['$isModeHidden?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return self.$playLongDensityWithTransfHidden(duration)
          } else if (self.statMode['$==']("ic")) {
            return self.$playLongDensityForIC(duration)
            } else {
            return self.$playLongDensityWithTransf(duration)
          }
        } else if ((($a = self['$isModeHidden?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.$playLongDensityBasicHidden(duration)
          } else {
          return self.$playLongDensityBasic(duration)
        };
      }, TMP_210.$$arity = -1);

      return (Opal.defn(self, '$playNextAfter', TMP_211 = function $$playNextAfter(duration) {
        var self = this;

        
				createjs.Tween.get(cqlsAEP.m.stage,{override:true}).wait(duration).call(
					function(tween) {
						if(cqlsAEP.i.loop) cqlsAEP.f.updateDemo();
					}
				);
			;
      }, TMP_211.$$arity = 1), nil) && 'playNextAfter';
    })($scope.base, null);

    (function($base, $super) {
      function $Distribution(){};
      var self = $Distribution = $klass($base, $super, 'Distribution', $Distribution);

      var def = self.$$proto, $scope = self.$$scope, TMP_212, TMP_213, TMP_215, TMP_216, TMP_217, TMP_221, TMP_222, TMP_223, TMP_224, TMP_226, TMP_227, TMP_228, TMP_229, TMP_230, TMP_231, TMP_232, TMP_233, TMP_234;

      def.list = def.name = def.params = def.originalDistrib = def.type = def.distrib = nil;
      self.$attr_accessor("list", "name", "params", "distrib");

      Opal.defn(self, '$initialize', TMP_212 = function $$initialize(name, params, transf) {
        var $a, $b, self = this;

        if (name == null) {
          name = nil;
        }
        if (params == null) {
          params = [];
        }
        if (transf == null) {
          transf = nil;
        }
        if ((($a = (($b = Opal.cvars['@@list']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@list'] = $hash2(["uniform", "normal", "t", "chi2", "exp", "cauchy", "discreteUniform", "bernoulli", "binomial", "birthday", "mean", "sum", "locationScale", "square", "sumOfSq"], {"uniform": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["UniformDistribution"], "qbounds": [0, 1]}), "normal": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["NormalDistribution"], "qbounds": [cqlsAEP.m.qmin, cqlsAEP.m.qmax]}), "t": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["StudentDistribution"], "qbounds": [cqlsAEP.m.qmin, cqlsAEP.m.qmax]}), "chi2": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["ChiSquareDistribution"], "qbounds": [0, cqlsAEP.m.qmax]}), "exp": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["ExponentialDistribution"], "qbounds": [0, cqlsAEP.m.qmax]}), "cauchy": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["CauchyDistribution"], "qbounds": [0.01, 0.99]}), "discreteUniform": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["DiscreteUniformDistribution"], "qbounds": [0, 1]}), "bernoulli": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BernoulliDistribution"], "qbounds": [0, 1]}), "binomial": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BinomialDistribution"], "qbounds": [0, 1]}), "birthday": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BirthdayDistribution"], "qbounds": [0.01, 1]}), "mean": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "sum": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "locationScale": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "square": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "sumOfSq": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]})}))
        };
        self.list = (($a = Opal.cvars['@@list']) == null ? nil : $a);
        if (name !== false && name !== nil && name != null) {
          if (transf !== false && transf !== nil && transf != null) {
            return self.$setAsTransfOf($scope.get('Distribution').$new(name, params), transf)
            } else {
            return self.$set(name, params)
          }
          } else {
          return nil
        };
      }, TMP_212.$$arity = -1);

      Opal.defn(self, '$set', TMP_213 = function $$set(dist, params) {
        var $a, self = this, instr = nil;

        $a = [dist, params], self.name = $a[0], self.params = $a[1], $a;
        self.type = self.list['$[]'](self.name)['$[]']("type");
        instr = $rb_plus($rb_plus($rb_plus($rb_plus("new ", self.list['$[]'](self.name)['$[]']("dist").$join(".")), "("), self.params.$join(",")), ");");
        return self.distrib = eval(instr);
      }, TMP_213.$$arity = 2);

      Opal.defn(self, '$setAsTransfOf', TMP_215 = function $$setAsTransfOf(dist, transf) {
        var $a, $b, TMP_214, self = this, $case = nil, d = nil;

        $a = [transf['$[]']("name"), transf['$[]']("args")], self.name = $a[0], self.params = $a[1], $a;
        self.originalDistrib = dist;
        return (function() {$case = self.name;if ("square"['$===']($case)) {return self.distrib = new PowerDistribution(self.originalDistrib.distrib,2)}else if ("mean"['$===']($case)) {d = new Convolution(self.originalDistrib.distrib,self.params['$[]'](0));
        return self.distrib = new LocationScaleDistribution(d,0,1/self.params['$[]'](0));}else if ("sum"['$===']($case)) {return self.distrib = new Convolution(self.originalDistrib.distrib,self.params['$[]'](0))}else if ("locationScale"['$===']($case)) {return self.distrib = new LocationScaleDistribution(self.originalDistrib.distrib,self.params['$[]'](0),self.params['$[]'](1))}else if ("sumOfSq"['$===']($case)) {d = new LocationScaleDistribution(self.originalDistrib.distrib,-self.originalDistrib.$mean()/self.originalDistrib.$stdDev(),1/self.originalDistrib.$stdDev());
        d = new PowerDistribution(d,2);
        if ((($a = d.type === CONT) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.distrib = new Convolution(d,self.params['$[]'](0))
          } else {
          self.distrib = $scope.get('Convolution').$power(d, self.params['$[]'](0));
          return self.$p(["boundsDistrib", self.$step(), self.$bounds(), self.$pdf(self.$bounds()), ($a = ($b = self.$pdf(self.$bounds())).$inject, $a.$$p = (TMP_214 = function(e, e2){var self = TMP_214.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = $rb_plus(e, e2)}, TMP_214.$$s = self, TMP_214.$$arity = 2, TMP_214), $a).call($b, 0)]);
        };}else { return nil }})();
      }, TMP_215.$$arity = 2);

      Opal.defn(self, '$type', TMP_216 = function $$type() {
        var $a, self = this;

        return ((($a = self.type) !== false && $a !== nil && $a != null) ? $a : self.originalDistrib.$type());
      }, TMP_216.$$arity = 0);

      Opal.defn(self, '$qbounds', TMP_217 = function $$qbounds() {
        var self = this;

        return self.list['$[]'](self.name)['$[]']("qbounds");
      }, TMP_217.$$arity = 0);

      Opal.defn(self, '$bounds', TMP_221 = function $$bounds() {
        var $a, $b, TMP_218, $c, $d, $e, TMP_219, TMP_220, self = this, qb = nil, $case = nil, a = nil, b = nil, s = nil;

        qb = (function() {if ((($a = self.originalDistrib) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.originalDistrib.$qbounds()
          } else {
          return self.$qbounds()
        }; return nil; })();
        return (function() {$case = self.$type();if ("cont"['$===']($case)) {return ($a = ($b = qb).$map, $a.$$p = (TMP_218 = function(e){var self = TMP_218.$$s || this;
if (e == null) e = nil;
        return self.$quantile(e)}, TMP_218.$$s = self, TMP_218.$$arity = 1, TMP_218), $a).call($b)}else if ("disc"['$===']($case)) {if ((($a = self['$regular?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          $c = ($d = ($e = qb).$map, $d.$$p = (TMP_219 = function(e){var self = TMP_219.$$s || this;
if (e == null) e = nil;
          return self.$quantile(e)}, TMP_219.$$s = self, TMP_219.$$arity = 1, TMP_219), $d).call($e), $a = Opal.to_ary($c), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]), $c;
          s = self.$step();
          return ($a = ($c = $scope.get('Range').$new(0, ($rb_divide(($rb_minus(b, a)), s))).$to_a()).$map, $a.$$p = (TMP_220 = function(e){var self = TMP_220.$$s || this;
if (e == null) e = nil;
          return $rb_plus(a, $rb_times(e, s))}, TMP_220.$$s = self, TMP_220.$$arity = 1, TMP_220), $a).call($c);
          } else {
          return self.distrib.values();
        }}else { return nil }})();
      }, TMP_221.$$arity = 0);

      Opal.defn(self, '$minValue', TMP_222 = function $$minValue() {
        var self = this;

        return self.distrib.minValue();
      }, TMP_222.$$arity = 0);

      Opal.defn(self, '$maxValue', TMP_223 = function $$maxValue() {
        var self = this;

        return self.distrib.maxValue();
      }, TMP_223.$$arity = 0);

      Opal.defn(self, '$regular?', TMP_224 = function() {
        var self = this;

        return self.distrib.regular();
      }, TMP_224.$$arity = 0);

      Opal.defn(self, '$step', TMP_226 = function $$step() {
        var $a, $b, TMP_225, self = this, b = nil;

        if ((($a = self['$regular?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.distrib.step();
          } else {
          b = self.$bounds();
          return ($a = ($b = ($range(1, b.$length(), true))).$map, $a.$$p = (TMP_225 = function(i){var self = TMP_225.$$s || this;
if (i == null) i = nil;
          return ($rb_minus(b['$[]'](i), b['$[]']($rb_minus(i, 1)))).$abs()}, TMP_225.$$s = self, TMP_225.$$arity = 1, TMP_225), $a).call($b).$min().$to_f();
        };
      }, TMP_226.$$arity = 0);

      Opal.defn(self, '$mean', TMP_227 = function $$mean() {
        var self = this;

        return self.distrib.mean();
      }, TMP_227.$$arity = 0);

      Opal.defn(self, '$mode', TMP_228 = function $$mode() {
        var self = this;

        return self.distrib.mode();
      }, TMP_228.$$arity = 0);

      Opal.defn(self, '$maxPdf', TMP_229 = function $$maxPdf() {
        var self = this;

        return self.distrib.maxDensity();
      }, TMP_229.$$arity = 0);

      Opal.defn(self, '$variance', TMP_230 = function $$variance() {
        var self = this;

        return self.distrib.variance();
      }, TMP_230.$$arity = 0);

      Opal.defn(self, '$stdDev', TMP_231 = function $$stdDev() {
        var self = this;

        return self.distrib.stdDev();
      }, TMP_231.$$arity = 0);

      Opal.defn(self, '$sample', TMP_232 = function $$sample(n) {
        var self = this;

        if (n == null) {
          n = 1;
        }
        z=[];for(i=0;i<n;i++) z[i]=self.distrib.simulate();return z
      }, TMP_232.$$arity = -1);

      Opal.defn(self, '$pdf', TMP_233 = function $$pdf(x) {
        var self = this;

        return x.map(function(e) {return self.distrib.density(e);});
      }, TMP_233.$$arity = 1);

      return (Opal.defn(self, '$quantile', TMP_234 = function $$quantile(alpha) {
        var self = this;

        return self.distrib.quantile(alpha);
      }, TMP_234.$$arity = 1), nil) && 'quantile';
    })($scope.base, null);

    (function($base, $super) {
      function $Convolution(){};
      var self = $Convolution = $klass($base, $super, 'Convolution', $Convolution);

      var def = self.$$proto, $scope = self.$$scope, TMP_236, TMP_237, TMP_238, TMP_243;

      def.b1 = def.bounds = nil;
      Opal.defs($scope.get('Convolution'), '$power', TMP_236 = function $$power(d, n) {
        var $a, $b, TMP_235, self = this, dist = nil, b = nil, dist2 = nil, b2 = nil;

        if ((($a = d instanceof Distribution) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          $a = [d, d.values()], dist = $a[0], b = $a[1], $a;
          $a = [d, d.values()], dist2 = $a[0], b2 = $a[1], $a;
          } else {
          $a = [d.$distrib(), d.$bounds()], dist = $a[0], b = $a[1], $a;
          $a = [d.$distrib(), d.$bounds()], dist2 = $a[0], b2 = $a[1], $a;
        };
        ($a = ($b = ($range(1, n, true))).$each, $a.$$p = (TMP_235 = function(i){var self = TMP_235.$$s || this;
if (i == null) i = nil;
        dist2 = new Convolution2(dist,dist2,b,b2);
          return b2 = dist2.values();}, TMP_235.$$s = self, TMP_235.$$arity = 1, TMP_235), $a).call($b);
        return dist2;
      }, TMP_236.$$arity = 2);

      Opal.defs($scope.get('Convolution'), '$two', TMP_237 = function $$two(d, d2) {
        var $a, self = this, dist = nil, b = nil, dist2 = nil, b2 = nil;

        $a = [d.$distrib(), d.$bounds()], dist = $a[0], b = $a[1], $a;
        $a = [d2.$distrib(), d2.$bounds()], dist2 = $a[0], b2 = $a[1], $a;
        return new Convolution2(dist,dist2,b,b2);
      }, TMP_237.$$arity = 2);

      Opal.defn(self, '$initialize', TMP_238 = function $$initialize(d1, d2, b1, b2) {
        var $a, self = this;

        $a = [d1, d2, b1, b2], self.d1 = $a[0], self.d2 = $a[1], self.b1 = $a[2], self.b2 = $a[3], $a;
        return self.$prepare();
      }, TMP_238.$$arity = 4);

      return (Opal.defn(self, '$prepare', TMP_243 = function $$prepare() {
        var $a, $b, TMP_239, $c, TMP_241, self = this, ind = nil;

        ind = $hash2([], {});
        ($a = ($b = self.b1).$each_with_index, $a.$$p = (TMP_239 = function(v1, i1){var self = TMP_239.$$s || this, $c, $d, TMP_240;
          if (self.b2 == null) self.b2 = nil;
if (v1 == null) v1 = nil;if (i1 == null) i1 = nil;
        return ($c = ($d = self.b2).$each_with_index, $c.$$p = (TMP_240 = function(v2, i2){var self = TMP_240.$$s || this, $e, v = nil;
if (v2 == null) v2 = nil;if (i2 == null) i2 = nil;
          v = $scope.get('CqlsAEP').$quantize($rb_plus(v1, v2));
            if ((($e = ind.$keys()['$include?'](v)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
              return ind['$[]'](v)['$<<']([i1, i2])
              } else {
              return ind['$[]='](v, [[i1, i2]])
            };}, TMP_240.$$s = self, TMP_240.$$arity = 2, TMP_240), $c).call($d)}, TMP_239.$$s = self, TMP_239.$$arity = 2, TMP_239), $a).call($b);
        self.bounds = ind.$keys().$sort();
        self.pdf = [];
        return ($a = ($c = self.bounds).$each_with_index, $a.$$p = (TMP_241 = function(v, i){var self = TMP_241.$$s || this, $d, $e, TMP_242;
          if (self.pdf == null) self.pdf = nil;
if (v == null) v = nil;if (i == null) i = nil;
        self.pdf['$[]='](i, 0);
          return ($d = ($e = ind['$[]'](v)).$each, $d.$$p = (TMP_242 = function(j1, j2){var self = TMP_242.$$s || this, $f, $g;
            if (self.pdf == null) self.pdf = nil;
            if (self.d1 == null) self.d1 = nil;
            if (self.b1 == null) self.b1 = nil;
            if (self.d2 == null) self.d2 = nil;
            if (self.b2 == null) self.b2 = nil;
if (j1 == null) j1 = nil;if (j2 == null) j2 = nil;
          return ($f = i, $g = self.pdf, $g['$[]=']($f, $rb_plus($g['$[]']($f), self.d1.density(self.b1['$[]'](j1))* self.d2.density(self.b2['$[]'](j2)))))}, TMP_242.$$s = self, TMP_242.$$arity = 2, TMP_242), $d).call($e);}, TMP_241.$$s = self, TMP_241.$$arity = 2, TMP_241), $a).call($c);
      }, TMP_243.$$arity = 0), nil) && 'prepare';
    })($scope.base, null);

    Opal.cdecl($scope, 'PREC4DISC', 0);

    Opal.defs($scope.get('CqlsAEP'), '$quantize', TMP_244 = function $$quantize(x, prec) {
      var self = this;

      if (prec == null) {
        prec = $scope.get('PREC4DISC');
      }
      return parseFloat(x.toFixed(prec));
    }, TMP_244.$$arity = -2);

    Opal.defs($scope.get('CqlsAEP'), '$equal', TMP_245 = function $$equal(a, b) {
      var self = this;

      return a.toFixed($scope.get('PREC4DISC'))===b.toFixed($scope.get('PREC4DISC'));
    }, TMP_245.$$arity = 2);

    Opal.defs($scope.get('CqlsAEP'), '$range', TMP_246 = function $$range(low, high, step) {
      var self = this;

      
			// From: http://phpjs.org/functions
			// +   original by: Waldo Malqui Silva
			// *     example 1: range ( 0, 12 );
			// *     returns 1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
			// *     example 2: range( 0, 100, 10 );
			// *     returns 2: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
			// *     example 3: range( 'a', 'i' );
			// *     returns 3: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
			// *     example 4: range( 'c', 'a' );
			// *     returns 4: ['c', 'b', 'a']
			var matrix = [];
			var inival, endval, plus;
			var walker = step || 1;
			var chars = false;

			if (!isNaN(low) && !isNaN(high)) {
			inival = low;
			endval = high;
			} else if (isNaN(low) && isNaN(high)) {
			chars = true;
			inival = low.charCodeAt(0);
			endval = high.charCodeAt(0);
			} else {
			inival = (isNaN(low) ? 0 : low);
			endval = (isNaN(high) ? 0 : high);
			}

			plus = ((inival > endval) ? false : true);
			if (plus) {
			while (inival <= endval) {
			  matrix.push(((chars) ? String.fromCharCode(inival) : inival));
			  inival += walker;
			}
			} else {
			while (inival >= endval) {
			  matrix.push(((chars) ? String.fromCharCode(inival) : inival));
			  inival -= walker;
			}
			}

			return matrix;
		
    }, TMP_246.$$arity = 3);

    Opal.defs($scope.get('CqlsAEP'), '$seq', TMP_247 = function $$seq(min, max, length) {
      var self = this;

      
			var arr = [],
			hival = Math.pow(10, 17 - ~~(Math.log(((max > 0) ? max : -max)) * Math.LOG10E)),
			step = (max * hival - min * hival) / ((length - 1) * hival),
			current = min,
			cnt = 0;
			// current is assigned using a technique to compensate for IEEE error
			for (; current <= max; cnt++, current = (min * hival + step * hival * cnt) / hival)
				arr.push(current);
			return arr;
		
    }, TMP_247.$$arity = 3);
  })($scope.base);
  return (function($base) {
    var $CqlsHypo, self = $CqlsHypo = $module($base, 'CqlsHypo');

    var def = self.$$proto, $scope = self.$$scope, TMP_384, TMP_385, TMP_386, TMP_387;

    (function($base) {
      var $Tooltip, self = $Tooltip = $module($base, 'Tooltip');

      var def = self.$$proto, $scope = self.$$scope, TMP_249;

      Opal.defn(self, '$initTooltip', TMP_249 = function $$initTooltip(shape) {
        var $a, $b, TMP_248, self = this;
        if (self.shape == null) self.shape = nil;

        if (shape == null) {
          shape = self.shape;
        }
        return ($a = ($b = shape).$each, $a.$$p = (TMP_248 = function(sh){var self = TMP_248.$$s || this;
if (sh == null) sh = nil;
        
					sh.on("rollover",function(evt) {
						//console.log("mouseover!!!"+evt.stageX/cqlsHypo.m.stage.scaleX+":"+evt.stageY/cqlsHypo.m.stage.scaleY);
						cqlsHypo.m.tooltip.text=self.$tooltipContent(sh, evt);
						cqlsHypo.m.tooltip.x=evt.stageX/cqlsHypo.m.stage.scaleX;
						cqlsHypo.m.tooltip.y=evt.stageY/cqlsHypo.m.stage.scaleY;
						cqlsHypo.m.tooltip.visible=true;
						//console.log("end mouseover");
						cqlsHypo.m.stage.update();
					});
					sh.on("pressmove",function(evt) {
						//console.log("mouseover!!!"+evt.stageX/cqlsHypo.m.stage.scaleX+":"+evt.stageY/cqlsHypo.m.stage.scaleY);
						cqlsHypo.m.tooltip.text=self.$tooltipContent(sh, evt);
						cqlsHypo.m.tooltip.x=evt.stageX/cqlsHypo.m.stage.scaleX;
						cqlsHypo.m.tooltip.y=evt.stageY/cqlsHypo.m.stage.scaleY;
						cqlsHypo.m.tooltip.visible=true;
						//console.log("end mouseover");
						cqlsHypo.m.stage.update();
					});
					sh.on("rollout",function(evt) {
						//console.log("mouseout!!!");
						cqlsHypo.m.tooltip.text="";
						cqlsHypo.m.tooltip.visible=false;
						cqlsHypo.m.stage.update();
					});
				;}, TMP_248.$$s = self, TMP_248.$$arity = 1, TMP_248), $a).call($b);
      }, TMP_249.$$arity = -1)
    })($scope.base);

    (function($base, $super) {
      function $Plot(){};
      var self = $Plot = $klass($base, $super, 'Plot', $Plot);

      var def = self.$$proto, $scope = self.$$scope, TMP_250, TMP_251, TMP_252, TMP_254, TMP_255, TMP_256;

      def.dim = def.frame = def.style = def.axisShape = def.updateCalls = def.graph = def.parent = nil;
      self.$attr_accessor("parent", "frame", "style", "graph", "dim");

      self.$include($scope.get('Tooltip'));

      Opal.defn(self, '$initialize', TMP_250 = function $$initialize(dim, style) {
        var $a, self = this;

        if (dim == null) {
          dim = $hash2(["x", "y", "w", "h"], {"x": 0, "y": 0, "w": cqlsHypo.i.dim.w, "h": cqlsHypo.i.dim.h});
        }
        if (style == null) {
          style = $hash2(["bg"], {"bg": "#88FF88"});
        }
        $a = [dim, style], self.dim = $a[0], self.style = $a[1], $a;
        self.parent = new createjs.Container();
        self.frame = new createjs.Shape();
        self.graph = (($scope.get('CqlsHypo')).$$scope.get('Graph')).$new(self.dim);
        self.updateCalls = [];
        self.frame.graphics.beginLinearGradientFill(["#FFF",self.style['$[]']("bg")], [0, 1], 0, self.dim['$[]']("y")+20, 0, self.dim['$[]']("y")+self.dim['$[]']("h")+20).drawRect(self.dim['$[]']("x"),self.dim['$[]']("y"),self.dim['$[]']("w"),self.dim['$[]']("h"));
        self.$addChild(self.frame);
        self.axisShape = new createjs.Shape();
        return self.$initTooltip([self.axisShape]);
      }, TMP_250.$$arity = -1);

      Opal.defn(self, '$attachAxis', TMP_251 = function $$attachAxis() {
        var self = this;

        return self.$addChild(self.axisShape, [self, "drawAxis"]);
      }, TMP_251.$$arity = 0);

      Opal.defn(self, '$addChild', TMP_252 = function $$addChild(child, updateCall, pos) {
        var $a, $b, self = this, shape = nil;

        if (updateCall == null) {
          updateCall = nil;
        }
        if (pos == null) {
          pos = -1;
        }
        shape = child;
        if (updateCall !== false && updateCall !== nil && updateCall != null) {
          self.updateCalls['$<<']([child, updateCall])};
        if ((($a = child.shape == null) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          shape = child.$shape();
          (($a = [self]), $b = child, $b['$plot='].apply($b, $a), $a[$a.length-1]);
          (($a = [self.graph]), $b = child, $b['$graph='].apply($b, $a), $a[$a.length-1]);
          self.graph.$add(child);
        };
        if ((($a = $rb_ge(pos, 0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.parent.addChildAt(shape,pos);
          } else {
          return self.parent.addChild(shape);
        };
      }, TMP_252.$$arity = -2);

      Opal.defn(self, '$update', TMP_254 = function $$update() {
        var $a, $b, TMP_253, self = this;

        return ($a = ($b = self.updateCalls).$each, $a.$$p = (TMP_253 = function(k, v){var self = TMP_253.$$s || this, $c, args = nil;
if (k == null) k = nil;if (v == null) v = nil;
        args = v['$[]'](2);
          if (args !== false && args !== nil && args != null) {
            } else {
            args = []
          };
          return ($c = v['$[]'](0).$method(v['$[]'](1))).$call.apply($c, Opal.to_a(args));}, TMP_253.$$s = self, TMP_253.$$arity = 2, TMP_253), $a).call($b);
      }, TMP_254.$$arity = 0);

      Opal.defn(self, '$drawAxis', TMP_255 = function $$drawAxis() {
        var self = this;

        return self.axisShape.graphics.ss(3,2).s("#000").mt(self.dim['$[]']("x"),self.graph.$to_Y(0.0)).lt($rb_plus(self.dim['$[]']("x"), self.dim['$[]']("w")),self.graph.$to_Y(0.0)).es();
      }, TMP_255.$$arity = 0);

      return (Opal.defn(self, '$tooltipContent', TMP_256 = function $$tooltipContent(shape, evt) {
        var self = this;

        return self.graph.$to_x(evt.stageX/cqlsHypo.m.stage.scaleX).$to_f();
      }, TMP_256.$$arity = 2), nil) && 'tooltipContent';
    })($scope.base, null);

    (function($base, $super) {
      function $Graph(){};
      var self = $Graph = $klass($base, $super, 'Graph', $Graph);

      var def = self.$$proto, $scope = self.$$scope, TMP_257, TMP_258, TMP_259, TMP_260, TMP_267, TMP_268, TMP_269, TMP_270, TMP_271, TMP_272, TMP_273, TMP_274, TMP_275, TMP_276, TMP_277, TMP_281, TMP_283, TMP_285;

      def.marg = def.dim = def.xylim0 = def.list = def.synced = def.xylim = def.zoom = def.tr = def.syncedChildren = def.active = def.zoomShapes = nil;
      self.$attr_accessor("xylim", "dim", "active", "syncedChildren", "zoom", "marg");

      Opal.defs($scope.get('Graph'), '$adjust', TMP_257 = function $$adjust(inter, more) {
        var self = this, l = nil;

        if (more == null) {
          more = 0;
        }
        l = $rb_times(($rb_minus(inter['$[]'](1), inter['$[]'](0))), more);
        return [$rb_minus(inter['$[]'](0), more), $rb_plus(inter['$[]'](1), more)];
      }, TMP_257.$$arity = -2);

      Opal.defn(self, '$initialize', TMP_258 = function $$initialize(dim, xlim, ylim, style) {
        var $a, self = this;

        if (xlim == null) {
          xlim = [];
        }
        if (ylim == null) {
          ylim = [];
        }
        if (style == null) {
          style = nil;
        }
        $a = [dim, style], self.dim = $a[0], self.style = $a[1], $a;
        self.marg = $hash2(["l", "r", "t", "b"], {"l": 0.1, "r": 0.1, "t": 0.2, "b": 0.1});
        if ((($a = $rb_lt(self.marg['$[]']("l"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("l", $rb_times(self.dim['$[]']("w"), self.marg['$[]']("l")))};
        if ((($a = $rb_lt(self.marg['$[]']("r"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("r", $rb_times(self.dim['$[]']("w"), self.marg['$[]']("r")))};
        if ((($a = $rb_lt(self.marg['$[]']("t"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("t", $rb_times(self.dim['$[]']("h"), self.marg['$[]']("t")))};
        if ((($a = $rb_lt(self.marg['$[]']("b"), 1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.marg['$[]=']("b", $rb_times(self.dim['$[]']("h"), self.marg['$[]']("b")))};
        self.xylim0 = $hash2(["x", "y"], {"x": xlim, "y": ylim});
        $a = [[], []], self.list = $a[0], self.active = $a[1], $a;
        if ((($a = self.xylim0['$[]']("x")['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.list['$<<'](self.xylim0)
        };
        self.xylim = $hash2(["x", "y"], {"x": [], "y": []});
        self.tr = $hash2([], {});
        self.zoom = $hash2(["x0", "x1", "y0", "y1", "active"], {"x0": 0.0, "x1": 0.0, "y0": 0.0, "y1": 0.0, "active": false});
        return self.syncedChildren = [];
      }, TMP_258.$$arity = -2);

      Opal.defn(self, '$syncTo', TMP_259 = function $$syncTo(graph) {
        var self = this;

        self.xylim = graph.$xylim();
        self.zoom = graph.$zoom();
        graph.$syncedChildren()['$<<'](self);
        return self.synced = true;
      }, TMP_259.$$arity = 1);

      Opal.defn(self, '$synced?', TMP_260 = function() {
        var self = this;

        return self.synced;
      }, TMP_260.$$arity = 0);

      Opal.defn(self, '$update', TMP_267 = function $$update(active) {
        var $a, $b, TMP_261, $c, TMP_262, $d, TMP_263, $e, TMP_264, $f, TMP_265, $g, TMP_266, self = this, list = nil;

        if (active == null) {
          active = self.active;
        }
        if ((($a = self['$synced?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          list = ($a = ($b = self.list).$select, $a.$$p = (TMP_261 = function(e){var self = TMP_261.$$s || this, $c;
if (e == null) e = nil;
          return ((($c = active['$empty?']()) !== false && $c !== nil && $c != null) ? $c : (active['$include?'](e['$[]'](1))))}, TMP_261.$$s = self, TMP_261.$$arity = 1, TMP_261), $a).call($b);
          self.xylim['$[]']("x")['$[]='](0, ($a = ($c = list).$map, $a.$$p = (TMP_262 = function(e){var self = TMP_262.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("x")['$[]'](0);}, TMP_262.$$s = self, TMP_262.$$arity = 1, TMP_262), $a).call($c).$min());
          self.xylim['$[]']("x")['$[]='](1, ($a = ($d = list).$map, $a.$$p = (TMP_263 = function(e){var self = TMP_263.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("x")['$[]'](1);}, TMP_263.$$s = self, TMP_263.$$arity = 1, TMP_263), $a).call($d).$max());
          self.xylim['$[]']("y")['$[]='](0, ($a = ($e = list).$map, $a.$$p = (TMP_264 = function(e){var self = TMP_264.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("y")['$[]'](0);}, TMP_264.$$s = self, TMP_264.$$arity = 1, TMP_264), $a).call($e).$min());
          self.xylim['$[]']("y")['$[]='](1, ($a = ($f = list).$map, $a.$$p = (TMP_265 = function(e){var self = TMP_265.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("y")['$[]'](1);}, TMP_265.$$s = self, TMP_265.$$arity = 1, TMP_265), $a).call($f).$max());
        };
        $a = [$rb_divide(($rb_minus($rb_minus($rb_plus(self.xylim['$[]']("x")['$[]'](1), self.zoom['$[]']("x1")), self.xylim['$[]']("x")['$[]'](0)), self.zoom['$[]']("x0"))), ($rb_minus($rb_minus(self.dim['$[]']("w"), self.marg['$[]']("l")), self.marg['$[]']("r")))), $rb_divide(($rb_minus($rb_minus($rb_plus(self.xylim['$[]']("y")['$[]'](0), self.zoom['$[]']("y0")), self.xylim['$[]']("y")['$[]'](1)), self.zoom['$[]']("y1"))), ($rb_minus($rb_minus(self.dim['$[]']("h"), self.marg['$[]']("t")), self.marg['$[]']("b"))))], self.tr['$[]=']("ax", $a[0]), self.tr['$[]=']("ay", $a[1]), $a;
        $a = [$rb_minus($rb_plus(self.xylim['$[]']("x")['$[]'](0), self.zoom['$[]']("x0")), $rb_times(self.tr['$[]']("ax"), ($rb_plus(self.dim['$[]']("x"), self.marg['$[]']("l"))))), $rb_minus($rb_plus(self.xylim['$[]']("y")['$[]'](1), self.zoom['$[]']("y1")), $rb_times(self.tr['$[]']("ay"), ($rb_plus(self.dim['$[]']("y"), self.marg['$[]']("t")))))], self.tr['$[]=']("bx", $a[0]), self.tr['$[]=']("by", $a[1]), $a;
        if ((($a = self.syncedChildren['$empty?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil
          } else {
          return ($a = ($g = self.syncedChildren).$each, $a.$$p = (TMP_266 = function(c){var self = TMP_266.$$s || this;
if (c == null) c = nil;
          return c.$update()}, TMP_266.$$s = self, TMP_266.$$arity = 1, TMP_266), $a).call($g)
        };
      }, TMP_267.$$arity = -1);

      Opal.defn(self, '$setActive', TMP_268 = function $$setActive(ary) {
        var self = this;

        return self.active = ary;
      }, TMP_268.$$arity = 1);

      Opal.defn(self, '$add', TMP_269 = function $$add(element, mode, id) {
        var $a, self = this, $case = nil;

        if (mode == null) {
          mode = "element";
        }
        if (id == null) {
          id = nil;
        }
        if ((($a = self['$synced?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return (function() {$case = mode;if ("element"['$===']($case)) {if ((($a = element.$xylim()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          self.list['$<<'](["element", ((($a = id) !== false && $a !== nil && $a != null) ? $a : element.$id()), element]);
          return self.$update();
          } else {
          return nil
        }}else if ("xylim"['$===']($case)) {self.list['$<<'](["xylim", id, element]);
        return self.$update();}else { return nil }})();
      }, TMP_269.$$arity = -2);

      Opal.defn(self, '$addXYLim', TMP_270 = function $$addXYLim(id, x0, x1, y0, y1) {
        var self = this;

        return self.$add($hash2(["x", "y"], {"x": [x0, x1], "y": [y0, y1]}), "xylim", id);
      }, TMP_270.$$arity = 5);

      Opal.defn(self, '$to_x', TMP_271 = function $$to_x(x) {
        var self = this;

        return $rb_plus($rb_times(self.tr['$[]']("ax"), x), self.tr['$[]']("bx"));
      }, TMP_271.$$arity = 1);

      Opal.defn(self, '$to_X', TMP_272 = function $$to_X(x) {
        var self = this;

        return $rb_divide(($rb_minus(x, self.tr['$[]']("bx"))), self.tr['$[]']("ax"));
      }, TMP_272.$$arity = 1);

      Opal.defn(self, '$to_y', TMP_273 = function $$to_y(y) {
        var self = this;

        return $rb_plus($rb_times(self.tr['$[]']("ay"), y), self.tr['$[]']("by"));
      }, TMP_273.$$arity = 1);

      Opal.defn(self, '$to_Y', TMP_274 = function $$to_Y(y) {
        var self = this;

        return $rb_divide(($rb_minus(y, self.tr['$[]']("by"))), self.tr['$[]']("ay"));
      }, TMP_274.$$arity = 1);

      Opal.defn(self, '$to_local', TMP_275 = function $$to_local(x, y) {
        var self = this;

        return [$rb_plus($rb_times(self.tr['$[]']("ax"), x), self.tr['$[]']("bx")), $rb_plus($rb_times(self.tr['$[]']("ay"), y), self.tr['$[]']("by"))];
      }, TMP_275.$$arity = 2);

      Opal.defn(self, '$to_global', TMP_276 = function $$to_global(x, y) {
        var self = this;

        return [$rb_divide(($rb_minus(x, self.tr['$[]']("bx"))), self.tr['$[]']("ax")), $rb_divide(($rb_minus(y, self.tr['$[]']("by"))), self.tr['$[]']("ay"))];
      }, TMP_276.$$arity = 2);

      Opal.defn(self, '$zoomActive', TMP_277 = function $$zoomActive() {
        var self = this;

        return self.zoom['$[]']("active");
      }, TMP_277.$$arity = 0);

      Opal.defn(self, '$toggleZoomTo', TMP_281 = function $$toggleZoomTo(plot, type) {
        var $a, $b, TMP_278, $c, TMP_279, $d, TMP_280, self = this, keys = nil;

        if (type == null) {
          type = ["xpos", "xneg", "ypos", "reset"];
        }
        self.zoom['$[]=']("active", self.zoom['$[]']("active")['$!']());
        if ((($a = self.zoom['$[]']("active")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          if ((($a = self.zoomShapes) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            } else {
            self.zoomShapes = $hash2([], {});
            keys = [];
            if ((($a = type['$include?']("xpos")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["xposmore", "xposless"])};
            if ((($a = type['$include?']("xneg")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["xnegmore", "xnegless"])};
            if ((($a = type['$include?']("ypos")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["yposmore", "yposless"])};
            if ((($a = type['$include?']("yneg")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["ynegmore", "ynegless"])};
            if ((($a = type['$include?']("reset")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
              keys = $rb_plus(keys, ["reset"])};
            ($a = ($b = keys).$each, $a.$$p = (TMP_278 = function(k){var self = TMP_278.$$s || this;
              if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
            return self.zoomShapes['$[]='](k, new createjs.Shape())}, TMP_278.$$s = self, TMP_278.$$arity = 1, TMP_278), $a).call($b);
          };
          ($a = ($c = self.zoomShapes).$each_key, $a.$$p = (TMP_279 = function(k){var self = TMP_279.$$s || this;
            if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
          
						plot.parent.addChild(self.zoomShapes['$[]'](k))
					;}, TMP_279.$$s = self, TMP_279.$$arity = 1, TMP_279), $a).call($c);
          return self.$showZoom();
          } else {
          return ($a = ($d = self.zoomShapes).$each_key, $a.$$p = (TMP_280 = function(k){var self = TMP_280.$$s || this;
            if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
          
						plot.parent.removeChild(self.zoomShapes['$[]'](k))
					;}, TMP_280.$$s = self, TMP_280.$$arity = 1, TMP_280), $a).call($d)
        };
      }, TMP_281.$$arity = -2);

      Opal.defn(self, '$showZoom', TMP_283 = function $$showZoom() {
        var $a, $b, TMP_282, self = this, size = nil, inter = nil;

        size = 40;
        inter = 15;
        return ($a = ($b = self.zoomShapes).$each_key, $a.$$p = (TMP_282 = function(k){var self = TMP_282.$$s || this, $case = nil;
          if (self.zoomShapes == null) self.zoomShapes = nil;
          if (self.dim == null) self.dim = nil;
if (k == null) k = nil;
        self.zoomShapes['$[]'](k).alpha=0.5;
          return (function() {$case = k;if ("xposmore"['$===']($case)) {return self.zoomShapes['$[]']("xposmore").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")-1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(self.dim['$[]']("w")-1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(self.dim['$[]']("w")-0.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("xposless"['$===']($case)) {return self.zoomShapes['$[]']("xposless").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")-1.5*size-inter,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(self.dim['$[]']("w")-1.5*size-inter,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(self.dim['$[]']("w")-2.5*size-inter,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("xnegmore"['$===']($case)) {return self.zoomShapes['$[]']("xnegmore").graphics.c().s("#000").f("#FFF").mt(1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(1.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(0.5*size,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("xnegless"['$===']($case)) {return self.zoomShapes['$[]']("xnegless").graphics.c().s("#000").f("#FFF").mt(1.5*size+inter,$rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2)).lt(1.5*size+inter,$rb_divide(self.dim['$[]']("h"), 2.0)+$rb_divide(size, 2)).lt(2.5*size+inter,$rb_divide(self.dim['$[]']("h"), 2.0)).cp() ;}else if ("ynegmore"['$===']($case)) {return self.zoomShapes['$[]']("ynegmore").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0),self.dim['$[]']("h")-0.5*size).cp() ;}else if ("ynegless"['$===']($case)) {return self.zoomShapes['$[]']("ynegless").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size-inter).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),self.dim['$[]']("h")-1.5*size-inter).lt($rb_divide(self.dim['$[]']("w"), 2.0),self.dim['$[]']("h")-2.5*size-inter).cp() ;}else if ("yposmore"['$===']($case)) {return self.zoomShapes['$[]']("yposmore").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),1.5*size).lt($rb_divide(self.dim['$[]']("w"), 2.0),0.5*size).cp() ;}else if ("yposless"['$===']($case)) {return self.zoomShapes['$[]']("yposless").graphics.c().s("#000").f("#FFF").mt($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2),1.5*size+inter).lt($rb_divide(self.dim['$[]']("w"), 2.0)+$rb_divide(size, 2),1.5*size+inter).lt($rb_divide(self.dim['$[]']("w"), 2.0),2.5*size+inter).cp() ;}else if ("reset"['$===']($case)) {return self.zoomShapes['$[]']("reset").graphics.c().s("#000").f("#FFF").drawRect($rb_divide(self.dim['$[]']("w"), 2.0)-$rb_divide(size, 2), $rb_divide(self.dim['$[]']("h"), 2.0)-$rb_divide(size, 2),size,size) ;}else { return nil }})();}, TMP_282.$$s = self, TMP_282.$$arity = 1, TMP_282), $a).call($b);
      }, TMP_283.$$arity = 0);

      return (Opal.defn(self, '$hitZoom', TMP_285 = function $$hitZoom(x, y) {
        var $a, $b, TMP_284, $c, self = this, select = nil, step = nil, $case = nil;

        if ((($a = self.zoom['$[]']("active")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          return nil
        };
        select = "none";
        (function(){var $brk = Opal.new_brk(); try {return ($a = ($b = self.zoomShapes).$each_key, $a.$$p = (TMP_284 = function(k){var self = TMP_284.$$s || this;
          if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
        if(self.zoomShapes['$[]'](k).hitTest(x, y)) {select=k};;
          if (select['$==']("none")) {
            return nil
            } else {
            
            Opal.brk(nil, $brk)
          };}, TMP_284.$$s = self, TMP_284.$$brk = $brk, TMP_284.$$arity = 1, TMP_284), $a).call($b)
        } catch (err) { if (err === $brk) { return err.$v } else { throw err } }})();
        if (select['$==']("none")) {
          return select};
        step = $rb_divide(0.1, 2);
        $case = select;if ("xposmore"['$===']($case)) {($a = "x1", $c = self.zoom, $c['$[]=']($a, $rb_plus($c['$[]']($a), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))))}else if ("xposless"['$===']($case)) {if ((($a = $rb_lt(self.zoom['$[]']("x1"), $rb_times(($rb_minus(step, $rb_divide(1, 2))), ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.zoom['$[]=']("x1", $rb_minus(self.zoom['$[]']("x1"), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0))))))
        }}else if ("xnegmore"['$===']($case)) {self.zoom['$[]=']("x0", $rb_minus(self.zoom['$[]']("x0"), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0))))))}else if ("xnegless"['$===']($case)) {if ((($a = $rb_gt(self.zoom['$[]']("x0"), $rb_times(($rb_minus($rb_divide(1, 2), step)), ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          ($a = "x0", $c = self.zoom, $c['$[]=']($a, $rb_plus($c['$[]']($a), $rb_times(step, ($rb_minus(self.xylim['$[]']("x")['$[]'](1), self.xylim['$[]']("x")['$[]'](0)))))))
        }}else if ("yposmore"['$===']($case)) {($a = "y1", $c = self.zoom, $c['$[]=']($a, $rb_plus($c['$[]']($a), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))))}else if ("yposless"['$===']($case)) {if ((($a = $rb_lt(self.zoom['$[]']("y1"), $rb_times(($rb_minus(step, $rb_divide(1, 2))), ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.zoom['$[]=']("y1", $rb_minus(self.zoom['$[]']("y1"), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0))))))
        }}else if ("ynegmore"['$===']($case)) {self.zoom['$[]=']("y0", $rb_minus(self.zoom['$[]']("y1"), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0))))))}else if ("ynegless"['$===']($case)) {if ((($a = $rb_gt(self.zoom['$[]']("y0"), $rb_times(($rb_minus($rb_divide(1, 2), step)), ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          ($a = "y0", $c = self.zoom, $c['$[]=']($a, $rb_plus($c['$[]']($a), $rb_times(step, ($rb_minus(self.xylim['$[]']("y")['$[]'](1), self.xylim['$[]']("y")['$[]'](0)))))))
        }}else if ("reset"['$===']($case)) {self.zoom['$[]=']("x0", self.zoom['$[]=']("x1", self.zoom['$[]=']("y0", self.zoom['$[]=']("y1", 0.0))))};
        return select;
      }, TMP_285.$$arity = 2), nil) && 'hitZoom';
    })($scope.base, null);

    (function($base, $super) {
      function $Child(){};
      var self = $Child = $klass($base, $super, 'Child', $Child);

      var def = self.$$proto, $scope = self.$$scope, TMP_286, TMP_287;

      def.plot = nil;
      self.$attr_accessor("id", "plot", "graph", "shape", "style", "xylim");

      self.$include($scope.get('Tooltip'));

      Opal.defn(self, '$initialize', TMP_286 = function $$initialize() {
        var self = this;

        return nil;
      }, TMP_286.$$arity = 0);

      return (Opal.defn(self, '$setPlot', TMP_287 = function $$setPlot(plot) {
        var self = this;

        self.plot = plot;
        return self.graph = self.plot.$graph();
      }, TMP_287.$$arity = 1), nil) && 'setPlot';
    })($scope.base, null);

    (function($base, $super) {
      function $Curve(){};
      var self = $Curve = $klass($base, $super, 'Curve', $Curve);

      var def = self.$$proto, $scope = self.$$scope, TMP_288, TMP_289, TMP_290, TMP_291, TMP_292, TMP_293, TMP_294, TMP_296, TMP_297, TMP_299, TMP_300, TMP_301, TMP_302, TMP_303, TMP_305, TMP_306, TMP_307, TMP_309, TMP_311, TMP_313, TMP_314;

      def.type = def.bounds = def.length = def.summaryShapes = def.plot = def.axisShape = def.graph = def.meanStyle = def.distrib = def.step = def.sdStyle = def.x = def.y = def.shape = def.style = nil;
      self.$attr_accessor("distrib", "bounds", "kind", "type", "style", "meanStyle", "sdStyle", "summaryShapes");

      Opal.defn(self, '$initialize', TMP_288 = function $$initialize(id, type, bounds, length) {
        var $a, $b, self = this, $case = nil;

        if (id == null) {
          id = nil;
        }
        if (type == null) {
          type = "cont";
        }
        if (bounds == null) {
          bounds = [0, 1];
        }
        if (length == null) {
          length = 512;
        }
        if ((($a = (($b = Opal.cvars['@@curve_cpt']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@curve_cpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil && $a != null) ? $a : $rb_plus("curve", ((Opal.cvars['@@curve_cpt'] = $rb_plus((($b = Opal.cvars['@@curve_cpt']) == null ? nil : $b), 1))).$to_s()));
        self.type = type;
        $case = self.type;if ("cont"['$===']($case)) {$a = [bounds, length], self.bounds = $a[0], self.length = $a[1], $a}else if ("disc"['$===']($case)) {self.bounds = bounds;
        self.length = self.bounds.$length();
        self.$initStep();};
        self.style = $hash2(["close", "stroke", "fill", "thickness"], {"close": true, "stroke": "#000", "fill": "rgba(200,200,255,0.3)", "thickness": 3});
        self.meanStyle = $hash2(["thickness", "stroke"], {"thickness": 3, "stroke": "#000"});
        self.sdStyle = $hash2(["thickness", "stroke"], {"thickness": 3, "stroke": "#000"});
        self.shape = new createjs.Shape();
        self.x = $scope.get('CqlsHypo').$seq(self.bounds['$[]'](0), self.bounds['$[]'](1), self.length);
        self.kind = "density";
        self.summaryShapes = [new createjs.Shape(), new createjs.Shape()];
        self.axisShape = new createjs.Shape();
        return self.$initTooltip(self.summaryShapes);
      }, TMP_288.$$arity = -1);

      Opal.defn(self, '$attachAxis', TMP_289 = function $$attachAxis(ratio) {
        var self = this;

        return self.plot.$addChild(self.axisShape, [self, "drawAxis", [ratio]]);
      }, TMP_289.$$arity = 1);

      Opal.defn(self, '$drawAxis', TMP_290 = function $$drawAxis(ratio) {
        var self = this;

        self.axisShape.visible=true;
        return self.axisShape.graphics.c().s("#000").ss(1).mt(self.graph.$dim()['$[]']("x"),$rb_times(self.graph.$dim()['$[]']("h"), ratio)).lt($rb_plus(self.graph.$dim()['$[]']("x"), self.graph.$dim()['$[]']("w")),$rb_times(self.graph.$dim()['$[]']("h"), ratio));
      }, TMP_290.$$arity = 1);

      Opal.defn(self, '$attachShapes', TMP_291 = function $$attachShapes() {
        var self = this;

        self.plot.$addChild(self.summaryShapes['$[]'](0), [self, "drawMean"]);
        return self.plot.$addChild(self.summaryShapes['$[]'](1), [self, "drawSD"]);
      }, TMP_291.$$arity = 0);

      Opal.defn(self, '$drawMean', TMP_292 = function $$drawMean() {
        var self = this;

        
				self.summaryShapes['$[]'](0).graphics.c().s(self.meanStyle['$[]']("stroke")).ss(self.meanStyle['$[]']("thickness")).mt(0,self.graph.$dim()['$[]']("y")).lt(0,$rb_plus(self.graph.$dim()['$[]']("y"), self.graph.$dim()['$[]']("h")))
				self.summaryShapes['$[]'](0).x=self.graph.$to_X(self.distrib.$mean());
				//self.summaryShapes['$[]'](0).y=self.graph.$dim()['$[]']("y");
			;
      }, TMP_292.$$arity = 0);

      Opal.defn(self, '$drawSD', TMP_293 = function $$drawSD() {
        var $a, self = this, x = nil, y = nil, h = nil;

        $a = [10, 10], x = $a[0], y = $a[1], $a;
        h = $rb_divide(self.distrib.$maxPdf(), 2.0);
        if (self.type['$==']("disc")) {
          h = $rb_divide(h, self.step)};
        h = self.graph.$to_Y(h);
        
				self.summaryShapes['$[]'](1).graphics.c().s(self.sdStyle['$[]']("stroke")).ss(self.sdStyle['$[]']("thickness"))
				.mt($rb_minus(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean()))+x,h-y)
				.lt($rb_minus(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean())),h)
				.lt($rb_minus(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean()))+x,h+y)
				.mt($rb_minus(self.graph.$to_X($rb_minus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean())),h)
				.lt($rb_minus(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean())),h)
				.lt($rb_minus(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean()))-x,h-y)
				.mt($rb_minus(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean())),h)
				.lt($rb_minus(self.graph.$to_X($rb_plus(self.distrib.$mean(), self.distrib.$stdDev())), self.graph.$to_X(self.distrib.$mean()))-x,h+y)
				self.summaryShapes['$[]'](1).x=self.graph.$to_X(self.distrib.$mean())
			;
      }, TMP_293.$$arity = 0);

      Opal.defn(self, '$sample', TMP_294 = function $$sample(n) {
        var self = this;

        if (n == null) {
          n = 1;
        }
        return self.distrib.$sample(n);
      }, TMP_294.$$arity = -1);

      Opal.defn(self, '$y', TMP_296 = function $$y(x) {
        var $a, $b, TMP_295, self = this, y = nil;

        y = self.distrib.$pdf(x);
        if (self.distrib.$type()['$==']("disc")) {
          ($a = ($b = y)['$map!'], $a.$$p = (TMP_295 = function(e){var self = TMP_295.$$s || this;
            if (self.distrib == null) self.distrib = nil;
if (e == null) e = nil;
          return $rb_divide(e, self.distrib.$step())}, TMP_295.$$s = self, TMP_295.$$arity = 1, TMP_295), $a).call($b)};
        y = y.map(function(e) {return Math.random()*e;});
        return y;
      }, TMP_296.$$arity = 1);

      Opal.defn(self, '$xy', TMP_297 = function $$xy(n) {
        var self = this, x = nil, y = nil;

        if (n == null) {
          n = 1;
        }
        x = self.$sample(n);
        y = self.$y(x);
        return $hash2(["x", "y"], {"x": x, "y": y});
      }, TMP_297.$$arity = -1);

      Opal.defn(self, '$initStep', TMP_299 = function $$initStep() {
        var $a, $b, TMP_298, self = this;

        return self.step = ($a = ($b = ($range(1, self.bounds.$length(), true))).$map, $a.$$p = (TMP_298 = function(i){var self = TMP_298.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return ($rb_minus(self.bounds['$[]'](i), self.bounds['$[]']($rb_minus(i, 1)))).$abs()}, TMP_298.$$s = self, TMP_298.$$arity = 1, TMP_298), $a).call($b).$min().$to_f();
      }, TMP_299.$$arity = 0);

      Opal.defn(self, '$setDistrib', TMP_300 = function $$setDistrib(name, params) {
        var self = this;

        self.distrib = $scope.get('Distribution').$new();
        self.distrib.$set(name, params);
        return self.$initDistrib();
      }, TMP_300.$$arity = 2);

      Opal.defn(self, '$setDistribAs', TMP_301 = function $$setDistribAs(dist) {
        var self = this;

        self.distrib = dist;
        return self.$initDistrib();
      }, TMP_301.$$arity = 1);

      Opal.defn(self, '$setDistribAsTransf', TMP_302 = function $$setDistribAsTransf(transf, dist) {
        var self = this;

        self.distrib = $scope.get('Distribution').$new();
        self.distrib.$setAsTransfOf(dist, transf);
        return self.$initDistrib();
      }, TMP_302.$$arity = 2);

      Opal.defn(self, '$regular?', TMP_303 = function() {
        var self = this;

        return self.distrib['$regular?']();
      }, TMP_303.$$arity = 0);

      Opal.defn(self, '$initDistrib', TMP_305 = function $$initDistrib() {
        var $a, $b, TMP_304, self = this, $case = nil;

        self.type = self.distrib.$type();
        self.bounds = self.distrib.$bounds();
        $case = self.type;if ("cont"['$===']($case)) {self.x = $scope.get('CqlsHypo').$seq(self.bounds['$[]'](0), self.bounds['$[]'](1), self.length)}else if ("disc"['$===']($case)) {self.$initStep();
        self.x = self.bounds;};
        self.y = self.distrib.$pdf(self.x);
        if (self.type['$==']("disc")) {
          ($a = ($b = self.y)['$map!'], $a.$$p = (TMP_304 = function(e){var self = TMP_304.$$s || this;
            if (self.step == null) self.step = nil;
if (e == null) e = nil;
          return $rb_divide(e, self.step)}, TMP_304.$$s = self, TMP_304.$$arity = 1, TMP_304), $a).call($b)};
        return self.$initXYLim();
      }, TMP_305.$$arity = 0);

      Opal.defn(self, '$initXYLim', TMP_306 = function $$initXYLim() {
        var self = this, xlim = nil;

        xlim = (function() {if (self.type['$==']("cont")) {
          return self.bounds
          } else {
          return [$rb_minus(self.bounds['$[]'](0), $rb_divide(self.step, 2.0)), $rb_plus(self.bounds['$[]'](-1), $rb_divide(self.step, 2.0))]
        }; return nil; })();
        return self.xylim = $hash2(["x", "y"], {"x": $scope.get('Graph').$adjust(xlim), "y": $scope.get('Graph').$adjust([0, self.y.$max()])});
      }, TMP_306.$$arity = 0);

      Opal.defn(self, '$draw', TMP_307 = function $$draw(shape, graph, style) {
        var self = this;

        if (shape == null) {
          shape = self.shape;
        }
        if (graph == null) {
          graph = self.graph;
        }
        if (style == null) {
          style = self.style;
        }
        if (self.type['$==']("cont")) {
          return self.$drawCont(shape, graph, style)
          } else {
          return self.$drawDisc(shape, graph, style)
        };
      }, TMP_307.$$arity = -1);

      Opal.defn(self, '$drawCont', TMP_309 = function $$drawCont(shape, graph, style) {
        var $a, $b, TMP_308, self = this;

        if (shape == null) {
          shape = self.shape;
        }
        if (graph == null) {
          graph = self.graph;
        }
        if (style == null) {
          style = self.style;
        }
        
				shape.graphics.clear();
				if(style['$[]']("close")) {shape.graphics.f(style['$[]']("fill"));}
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        shape.x=graph.$to_X(self.distrib.$mean());
        shape.graphics.mt(graph.$to_X(self.x['$[]'](0))-shape.x,graph.$to_Y(0.0));
        ($a = ($b = ($range(0, self.x.$length(), true))).$each, $a.$$p = (TMP_308 = function(i){var self = TMP_308.$$s || this;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        return shape.graphics.lt(graph.$to_X(self.x['$[]'](i))-shape.x,graph.$to_Y(self.y['$[]'](i)));}, TMP_308.$$s = self, TMP_308.$$arity = 1, TMP_308), $a).call($b);
        shape.graphics.lt(graph.$to_X(self.x['$[]'](-1))-shape.x,graph.$to_Y(0.0));
        if ((($a = style['$[]']("close")) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return shape.graphics.cp();
          } else {
          return nil
        };
      }, TMP_309.$$arity = -1);

      Opal.defn(self, '$drawDisc', TMP_311 = function $$drawDisc(shape, graph, style) {
        var $a, $b, TMP_310, self = this, s = nil;

        if (shape == null) {
          shape = self.shape;
        }
        if (graph == null) {
          graph = self.graph;
        }
        if (style == null) {
          style = self.style;
        }
        s = $rb_divide(self.step, 2.0);
        
				shape.graphics.clear();
				if(style['$[]']("close")) {shape.graphics.f(style['$[]']("fill"));}
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        return ($a = ($b = ($range(0, self.x.$length(), true))).$each, $a.$$p = (TMP_310 = function(i){var self = TMP_310.$$s || this, $c;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        
				 	shape.graphics.mt(graph.$to_X($rb_minus(self.x['$[]'](i), s)),graph.$to_Y(0.0))
					.lt(graph.$to_X($rb_minus(self.x['$[]'](i), s)),graph.$to_Y(self.y['$[]'](i)))
					.lt(graph.$to_X($rb_plus(self.x['$[]'](i), s)),graph.$to_Y(self.y['$[]'](i)))
			 		.lt(graph.$to_X($rb_plus(self.x['$[]'](i), s)),graph.$to_Y(0.0))
			 	;
          if ((($c = style['$[]']("close")) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            return shape.graphics.cp();
            } else {
            return nil
          };}, TMP_310.$$s = self, TMP_310.$$arity = 1, TMP_310), $a).call($b);
      }, TMP_311.$$arity = -1);

      Opal.defn(self, '$drawAreaSide', TMP_313 = function $$drawAreaSide(lim, side, shape, style, graph) {
        var $a, $b, $c, TMP_312, self = this, $case = nil, from = nil, to = nil;

        if (style == null) {
          style = self.style;
        }
        if (graph == null) {
          graph = self.graph;
        }
        $case = side;if ("left"['$===']($case)) {$a = [0, 0], from = $a[0], to = $a[1], $a;
        while ((($b = ($c = $rb_lt(to, $rb_minus(self.x.$length(), 1)), $c !== false && $c !== nil && $c != null ?$rb_le(self.x['$[]'](to), lim) : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        to = $rb_plus(to, 1)};}else if ("right"['$===']($case)) {$a = [$rb_minus(self.x.$length(), 1), $rb_minus(self.x.$length(), 1)], from = $a[0], to = $a[1], $a;
        while ((($b = ($c = $rb_gt(from, 0), $c !== false && $c !== nil && $c != null ?$rb_ge(self.x['$[]'](from), lim) : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        from = $rb_minus(from, 1)};}else if ("between"['$===']($case)) {$a = [0, $rb_minus(self.x.$length(), 1)], from = $a[0], to = $a[1], $a;
        while ((($b = ($c = $rb_lt(from, $rb_minus(self.x.$length(), 1)), $c !== false && $c !== nil && $c != null ?$rb_lt(self.x['$[]'](from), lim['$[]'](0)) : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        from = $rb_plus(from, 1)};
        while ((($b = ($c = $rb_gt(to, 0), $c !== false && $c !== nil && $c != null ?$rb_gt(self.x['$[]'](to), lim['$[]'](1)) : $c)) !== nil && $b != null && (!$b.$$is_boolean || $b == true))) {
        to = $rb_minus(to, 1)};};
        
				shape.graphics.clear();
				shape.graphics.f(style['$[]']("fill"));
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        shape.x=graph.$to_X(self.distrib.$mean());
        shape.graphics.mt(graph.$to_X(self.x['$[]'](from))-shape.x,graph.$to_Y(0.0));
        ($a = ($b = ($range(from, to, false))).$each, $a.$$p = (TMP_312 = function(i){var self = TMP_312.$$s || this;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        return shape.graphics.lt(graph.$to_X(self.x['$[]'](i))-shape.x,graph.$to_Y(self.y['$[]'](i)));}, TMP_312.$$s = self, TMP_312.$$arity = 1, TMP_312), $a).call($b);
        shape.graphics.lt(graph.$to_X(self.x['$[]'](to))-shape.x,graph.$to_Y(0.0));
        return shape.graphics.cp();
      }, TMP_313.$$arity = -4);

      return (Opal.defn(self, '$tooltipContent', TMP_314 = function $$tooltipContent(shape, evt) {
        var $a, self = this;

        if ((($a = shape == self.summaryShapes['$[]'](0)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.distrib.$mean().$to_s()
        } else if ((($a = shape==self.summaryShapes['$[]'](1)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.distrib.$stdDev().$to_s()
          } else {
          return nil
        };
      }, TMP_314.$$arity = 2), nil) && 'tooltipContent';
    })($scope.base, $scope.get('Child'));

    (function($base) {
      var $Callables, self = $Callables = $module($base, 'Callables');

      var def = self.$$proto, $scope = self.$$scope, TMP_315, TMP_316, TMP_317, TMP_319;

      Opal.defn(self, '$suspendCallables', TMP_315 = function $$suspendCallables(tag) {
        var self = this;
        if (self.activeCallables == null) self.activeCallables = nil;

        if (tag == null) {
          tag = "default";
        }
        return self.activeCallables['$[]='](tag, false);
      }, TMP_315.$$arity = -1);

      Opal.defn(self, '$resumeCallables', TMP_316 = function $$resumeCallables(tag) {
        var self = this;
        if (self.activeCallables == null) self.activeCallables = nil;

        if (tag == null) {
          tag = "default";
        }
        return self.activeCallables['$[]='](tag, true);
      }, TMP_316.$$arity = -1);

      Opal.defn(self, '$addCallable', TMP_317 = function $$addCallable(call, tag) {
        var $a, self = this;
        if (self.callables == null) self.callables = nil;
        if (self.activeCallables == null) self.activeCallables = nil;

        if (tag == null) {
          tag = "default";
        }
        if ((($a = self.callables) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          $a = [$hash2([], {}), $hash2([], {})], self.callables = $a[0], self.activeCallables = $a[1], $a
        };
        if ((($a = self.callables['$[]'](tag)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          $a = [[], []], self.callables['$[]='](tag, $a[0]), self.activeCallables['$[]='](tag, $a[1]), $a
        };
        return self.callables['$[]'](tag)['$<<'](call);
      }, TMP_317.$$arity = -2);

      Opal.defn(self, '$playCallables', TMP_319 = function $$playCallables(tag) {
        var $a, $b, TMP_318, self = this;
        if (self.callables == null) self.callables = nil;
        if (self.activeCallables == null) self.activeCallables = nil;

        if (tag == null) {
          tag = "default";
        }
        if ((($a = ($b = self.callables['$[]'](tag), $b !== false && $b !== nil && $b != null ?self.activeCallables['$[]'](tag) : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return ($a = ($b = self.callables['$[]'](tag)).$each, $a.$$p = (TMP_318 = function(v){var self = TMP_318.$$s || this, $c, args = nil;
if (v == null) v = nil;
          args = v['$[]'](2);
            if (args !== false && args !== nil && args != null) {
              } else {
              args = []
            };
            return ($c = v['$[]'](0).$method(v['$[]'](1))).$call.apply($c, Opal.to_a(args));}, TMP_318.$$s = self, TMP_318.$$arity = 1, TMP_318), $a).call($b)
          } else {
          return nil
        };
      }, TMP_319.$$arity = -1);
    })($scope.base);

    (function($base, $super) {
      function $StatTestCurve(){};
      var self = $StatTestCurve = $klass($base, $super, 'StatTestCurve', $StatTestCurve);

      var def = self.$$proto, $scope = self.$$scope, TMP_320, TMP_321, TMP_323, TMP_324, TMP_325, TMP_326;

      def.styles = def.paramsFrame = def.typeStatTest = def.paramsStatTest = nil;
      self.$attr_accessor("typeStatTest", "paramsFrame", "paramsStatTest");

      self.$include($scope.get('Callables'));

      Opal.defn(self, '$initialize', TMP_320 = function $$initialize(type, params) {
        var $a, $b, self = this, $iter = TMP_320.$$p, $yield = $iter || nil;

        if (type == null) {
          type = "p";
        }
        if (params == null) {
          params = [1000, 0.15];
        }
        TMP_320.$$p = null;
        ($a = ($b = self, Opal.find_super_dispatcher(self, 'initialize', TMP_320, false)), $a.$$p = null, $a).call($b);
        self.$setParamsFrame(type, params);
        return self.styles;
      }, TMP_320.$$arity = -1);

      Opal.defn(self, '$setStyle', TMP_321 = function $$setStyle() {
        var self = this;

        return nil;
      }, TMP_321.$$arity = 0);

      Opal.defn(self, '$initEvents', TMP_323 = function $$initEvents(types) {
        var $a, $b, TMP_322, self = this;

        if (types == null) {
          types = ["mean", "sd"];
        }
        return ($a = ($b = types).$each, $a.$$p = (TMP_322 = function(type){var self = TMP_322.$$s || this, $case = nil;
          if (self.summaryShapes == null) self.summaryShapes = nil;
          if (self.typeStatTest == null) self.typeStatTest = nil;
          if (self.paramsFrame == null) self.paramsFrame = nil;
          if (self.graph == null) self.graph = nil;
          if (self.distrib == null) self.distrib = nil;
          if (self.delta == null) self.delta = nil;
          if (self.sdX == null) self.sdX = nil;
          if (self.oldSD == null) self.oldSD = nil;
if (type == null) type = nil;
        return (function() {$case = type;if ("mean"['$===']($case)) {
						self.summaryShapes['$[]'](0).on("pressmove", function(evt) {
							var x=evt.stageX/cqlsHypo.m.stage.scaleX;
							if(self.typeStatTest['$==']("p")){
								self.paramsFrame['$[]='](1, self.graph.$to_x(x))
								self.$updateStatTestDistrib()
								//console.log("mean="+self.distrib.$mean()+",sd="+self.distrib.$stdDev())
								self.$draw();
								self.$drawMean();
								self.$drawSD();
								self.$playCallables();
								cqlsHypo.m.stage.update();
						    } else if(self.typeStatTest['$==']("m")) {
						    	//console.log("MEAN pressed");
						    	self.paramsFrame['$[]='](1, self.graph.$to_x(x))
								self.$updateStatTestDistrib()
								//console.log("mean="+self.distrib.$mean()+",sd="+self.distrib.$stdDev())
								self.$draw();
								self.$drawMean();
								self.$drawSD();
								//console.log("MEAN pressed -> delta:"+self.delta);
								self.$playCallables();
								//console.log("MEAN OUT");
							}
						    cqlsHypo.m.stage.update();
						});
						self.summaryShapes['$[]'](0).on("pressup", function(evt) {
							var x=evt.stageX/cqlsHypo.m.stage.scaleX;
							//console.log("TTTTTypeStatTest:"+self.typeStatTest)
							if(self.typeStatTest['$==']("p")){
								//console.log("prop up");
								self.paramsFrame['$[]='](1, self.graph.$to_x(x))
								self.$updateStatTestDistrib()
								//console.log("mean="+self.distrib.$mean()+",sd="+self.distrib.$stdDev())
								self.$draw();
								self.$drawSD();
							} else if(self.typeStatTest['$==']("m")) {
								//console.log("MEANNNN UUUUUPPPPP");
								self.paramsFrame['$[]='](1, self.graph.$to_x(x))
								self.$updateStatTestDistrib()
								//console.log("mean="+self.distrib.$mean()+",sd="+self.distrib.$stdDev())
							}
							cqlsHypo.m.stage.update();
						});
					;}else if ("sd"['$===']($case)) {
						self.summaryShapes['$[]'](1).on("mousedown", function(evt) {
							if(self.typeStatTest['$==']("m")) {
								//console.log("sd down");
								self.sdX=evt.stageX/cqlsHypo.m.stage.scaleX;
								self.oldSD = $rb_minus(self.graph.$to_X(self.distrib.$stdDev()), self.graph.$to_X(0.0));
							}
						});
						self.summaryShapes['$[]'](1).on("pressmove", function(evt) {
							var x=evt.stageX/cqlsHypo.m.stage.scaleX;
							if(self.typeStatTest['$==']("m")) {
								//console.log("sd pressed");

								var newSD=self.oldSD+x-self.sdX;
						    	//self.summaryShapes['$[]'](1).scaleX=newSD/oldSD;
						    	//point at the right in the real scale then substracted from real mean
						    	//Do not forget the sqrt(n) because it is the
						    	self.paramsFrame['$[]='](2, $rb_times(self.graph.$to_x($rb_minus($rb_plus($rb_plus(self.graph.$to_X(0.0), self.oldSD), x), self.sdX)), Math.sqrt(self.paramsFrame['$[]'](0))));
						    	self.$updateStatTestDistrib()
						    	self.$draw();
						    	self.$drawSD();
						    	self.$playCallables("sd");
						    	//console.log("mean="+self.distrib.$mean()+",sd="+self.distrib.$stdDev())
						    	cqlsHypo.m.stage.update();
						    }
						});
					;}else { return nil }})()}, TMP_322.$$s = self, TMP_322.$$arity = 1, TMP_322), $a).call($b);
      }, TMP_323.$$arity = -1);

      Opal.defn(self, '$paramsFrameAtFrom', TMP_324 = function $$paramsFrameAtFrom(key, statTest2, key2) {
        var $a, self = this;

        if (key2 == null) {
          key2 = nil;
        }
        if ((($a = key2['$nil?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          key2 = key};
        return self.paramsFrame['$[]='](key, statTest2.$paramsFrame()['$[]'](key2));
      }, TMP_324.$$arity = -3);

      Opal.defn(self, '$setParamsFrame', TMP_325 = function $$setParamsFrame(type, params) {
        var self = this;

        if (type == null) {
          type = "p";
        }
        if (params == null) {
          params = [1000, 0.15];
        }
        self.typeStatTest = type;
        self.paramsFrame = params;
        return self.$updateStatTestDistrib();
      }, TMP_325.$$arity = -1);

      return (Opal.defn(self, '$updateStatTestDistrib', TMP_326 = function $$updateStatTestDistrib() {
        var self = this, $case = nil, paramsFrame = nil;

        self.paramsStatTest = (function() {$case = self.typeStatTest;if ("p"['$===']($case)) {return [self.paramsFrame['$[]'](1), Math.sqrt($rb_divide($rb_times(self.paramsFrame['$[]'](1), ($rb_minus(1, self.paramsFrame['$[]'](1)))), self.paramsFrame['$[]'](0)))]}else if ("m"['$===']($case)) {return [self.paramsFrame['$[]'](1), $rb_divide(self.paramsFrame['$[]'](2), Math.sqrt(self.paramsFrame['$[]'](0)))]}else if ("dp0"['$===']($case) || "dm0"['$===']($case)) {return [0, 1]}else if ("dp"['$===']($case) || "dp1"['$===']($case)) {paramsFrame = (function() {if (self.typeStatTest['$==']("dp1")) {
          return [self.paramsFrame['$[]'](0).$paramsFrame()['$[]'](0), self.paramsFrame['$[]'](1), self.paramsFrame['$[]'](0).$paramsFrame()['$[]'](1)]
          } else {
          return self.paramsFrame
        }; return nil; })();
        return [$rb_divide(($rb_minus(paramsFrame['$[]'](2), paramsFrame['$[]'](1))), Math.sqrt($rb_divide($rb_times(paramsFrame['$[]'](1), ($rb_minus(1, paramsFrame['$[]'](1)))), paramsFrame['$[]'](0)))), Math.sqrt($rb_divide(($rb_times(paramsFrame['$[]'](2), ($rb_minus(1, paramsFrame['$[]'](2))))), ($rb_times(paramsFrame['$[]'](1), ($rb_minus(1, paramsFrame['$[]'](1)))))))];}else if ("dm"['$===']($case) || "dm1"['$===']($case)) {paramsFrame = (function() {if (self.typeStatTest['$==']("dm1")) {
          return [self.paramsFrame['$[]'](0).$paramsFrame()['$[]'](0), self.paramsFrame['$[]'](1), self.paramsFrame['$[]'](0).$paramsFrame()['$[]'](1), self.paramsFrame['$[]'](0).$paramsFrame()['$[]'](2)]
          } else {
          return self.paramsFrame
        }; return nil; })();
        return [$rb_times($rb_divide(($rb_minus(paramsFrame['$[]'](2), paramsFrame['$[]'](1))), paramsFrame['$[]'](3)), Math.sqrt(paramsFrame['$[]'](0))), 1];}else { return nil }})();
        return self.$setDistrib("normal", self.paramsStatTest);
      }, TMP_326.$$arity = 0), nil) && 'updateStatTestDistrib';
    })($scope.base, $scope.get('Curve'));

    (function($base, $super) {
      function $AcceptanceRegion(){};
      var self = $AcceptanceRegion = $klass($base, $super, 'AcceptanceRegion', $AcceptanceRegion);

      var def = self.$$proto, $scope = self.$$scope, TMP_327, TMP_328, TMP_329, TMP_330, TMP_331, TMP_333, TMP_334, TMP_335;

      def.shapes = def.graph = def.alpha = def.context = def.statTestH0 = def.side = def.sides = def.plot = nil;
      self.$attr_accessor("alpha", "side", "style", "shapes");

      self.$include($scope.get('Callables'));

      Opal.defn(self, '$initialize', TMP_327 = function $$initialize(statTestH0, context, id) {
        var $a, $b, self = this;

        if (id == null) {
          id = nil;
        }
        if ((($a = (($b = Opal.cvars['@@limitCpt']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@limitCpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil && $a != null) ? $a : $rb_plus("Lim", ((Opal.cvars['@@limitCpt'] = $rb_plus((($b = Opal.cvars['@@limitCpt']) == null ? nil : $b), 1))).$to_s()));
        $a = [statTestH0, context], self.statTestH0 = $a[0], self.context = $a[1], $a;
        self.style = $hash2(["stroke", "thickness"], {"stroke": "#0F0", "thickness": 3});
        self.sides = [];
        self.shapes = [new createjs.Shape(), new createjs.Shape()];
        self.alpha = "context";
        self.side = "context";
        return self.$initTooltip(self.shapes);
      }, TMP_327.$$arity = -3);

      Opal.defn(self, '$initEvents', TMP_328 = function $$initEvents() {
        var self = this;

        

				self.shapes['$[]'](0).on("pressmove", function(evt) {
					var x=evt.stageX/cqlsHypo.m.stage.scaleX;

					self.$setAlphaFromQuantile(self.graph.$to_x(x), "left")
					self.$draw()
					self.$playCallables();
					cqlsHypo.m.stage.update();
			     });

				self.shapes['$[]'](1).on("pressmove", function(evt) {
					var x=evt.stageX/cqlsHypo.m.stage.scaleX;

					self.$setAlphaFromQuantile(self.graph.$to_x(x), "right")
					self.$draw()
					self.$playCallables();
					cqlsHypo.m.stage.update();
			     });
			;
      }, TMP_328.$$arity = 0);

      Opal.defn(self, '$setAlpha', TMP_329 = function $$setAlpha(alpha) {
        var self = this, $case = nil;

        return (function() {$case = self.alpha;if ("context"['$===']($case)) {return self.context['$[]=']("alpha", alpha)}else if ("paramPval"['$===']($case)) {return self.context['$[]=']("paramPval", alpha)}else if ("deltaPval"['$===']($case)) {return self.context['$[]=']("deltaPval", alpha)}else {return self.alpha = alpha}})();
      }, TMP_329.$$arity = 1);

      Opal.defn(self, '$setAlphaFromQuantile', TMP_330 = function $$setAlphaFromQuantile(q, from) {
        var self = this, $case = nil, alpha = nil;

        if (from == null) {
          from = "right";
        }
        $case = from;if ("right"['$===']($case)) {alpha = $rb_minus(1, self.statTestH0.$distrib().$cdf(q))}else if ("left"['$===']($case)) {alpha = self.statTestH0.$distrib().$cdf(q)};
        if (((function() {if (self.side['$==']("context")) {
          return self.context['$[]']("side")
          } else {
          return self.side
        }; return nil; })())['$==']("!=")) {
          alpha = $rb_times(2, alpha)};
        alpha = [alpha, 1.0].$min();
        return self.$setAlpha(alpha);
      }, TMP_330.$$arity = -2);

      Opal.defn(self, '$getSides', TMP_331 = function $$getSides() {
        var self = this, side = nil, alpha = nil, $case = nil;

        side = (function() {if (self.side['$==']("context")) {
          return self.context['$[]']("side")
          } else {
          return self.side
        }; return nil; })();
        alpha = (function() {$case = self.alpha;if ("context"['$===']($case)) {return self.context['$[]']("alpha")}else if ("paramPval"['$===']($case)) {return self.context['$[]']("paramPval")}else if ("deltaPval"['$===']($case)) {return self.context['$[]']("deltaPval")}else {return self.alpha}})();
        return (function() {$case = side;if (">"['$===']($case)) {return self.sides = [0, $rb_minus(1, alpha)]}else if ("<"['$===']($case)) {return self.sides = [alpha, 0]}else if ("!="['$===']($case)) {return self.sides = [$rb_divide(alpha, 2.0), $rb_minus(1, $rb_divide(alpha, 2.0))]}else { return nil }})();
      }, TMP_331.$$arity = 0);

      Opal.defn(self, '$draw', TMP_333 = function $$draw() {
        var $a, $b, TMP_332, self = this;

        self.$getSides();
        return ($a = ($b = self.sides).$each_with_index, $a.$$p = (TMP_332 = function(s, i){var self = TMP_332.$$s || this, $c;
          if (self.shapes == null) self.shapes = nil;
          if (self.style == null) self.style = nil;
          if (self.graph == null) self.graph = nil;
          if (self.statTestH0 == null) self.statTestH0 = nil;
if (s == null) s = nil;if (i == null) i = nil;
        if ((($c = $rb_gt(s, 0)) !== nil && $c != null && (!$c.$$is_boolean || $c == true))) {
            
						self.shapes['$[]'](i).graphics.c().s(self.style['$[]']("stroke")).ss(self.style['$[]']("thickness")).mt(0,self.graph.$dim()['$[]']("y")).lt(0,$rb_plus(self.graph.$dim()['$[]']("y"), self.graph.$dim()['$[]']("h")))
						self.shapes['$[]'](i).x=self.graph.$to_X(self.statTestH0.$distrib().$quantile(s));
					;
            } else {
            return self.shapes['$[]'](i).graphics.c();
          }}, TMP_332.$$s = self, TMP_332.$$arity = 2, TMP_332), $a).call($b);
      }, TMP_333.$$arity = 0);

      Opal.defn(self, '$attachShapes', TMP_334 = function $$attachShapes() {
        var self = this;

        self.plot.$addChild(self.shapes['$[]'](0), [self, "draw"]);
        return self.plot.$addChild(self.shapes['$[]'](1), [self, "draw"]);
      }, TMP_334.$$arity = 0);

      return (Opal.defn(self, '$tooltipContent', TMP_335 = function $$tooltipContent(shape, evt) {
        var self = this;

        return self.graph.$to_x(shape.x).$to_s();
      }, TMP_335.$$arity = 2), nil) && 'tooltipContent';
    })($scope.base, $scope.get('Child'));

    (function($base, $super) {
      function $AreaRisk(){};
      var self = $AreaRisk = $klass($base, $super, 'AreaRisk', $AreaRisk);

      var def = self.$$proto, $scope = self.$$scope, TMP_336, TMP_337, TMP_339, TMP_340, TMP_341;

      def.shapes = def.side = def.context = def.statTest = def.alpha = def.sides = def.style = def.graph = def.plot = nil;
      self.$attr_accessor("alpha", "side", "style", "shapes");

      Opal.defn(self, '$initialize', TMP_336 = function $$initialize(statTest, context, id) {
        var $a, $b, self = this;

        if (id == null) {
          id = nil;
        }
        if ((($a = (($b = Opal.cvars['@@areaCpt']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@areaCpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil && $a != null) ? $a : $rb_plus("Risk", ((Opal.cvars['@@areaCpt'] = $rb_plus((($b = Opal.cvars['@@areaCpt']) == null ? nil : $b), 1))).$to_s()));
        $a = [statTest, context], self.statTest = $a[0], self.context = $a[1], $a;
        self.style = $hash2(["stroke", "fill", "thickness"], {"stroke": "rgba(255,0,0,.6)", "fill": "rgba(255,0,0,.3)", "thickness": 1});
        self.sides = [];
        self.shapes = [new createjs.Shape(), new createjs.Shape()];
        self.alpha = "context";
        self.side = "context";
        return self.$initTooltip(self.shapes);
      }, TMP_336.$$arity = -3);

      Opal.defn(self, '$getSides', TMP_337 = function $$getSides() {
        var $a, self = this, side = nil, statTestQuantile = nil, alpha = nil, $case = nil, param = nil;

        side = (function() {if (self.side['$==']("context")) {
          return self.context['$[]']("side")
          } else {
          return self.side
        }; return nil; })();
        statTestQuantile = self.statTest;
        alpha = (function() {$case = self.alpha;if ("context"['$===']($case)) {return self.context['$[]']("alpha")}else if ("paramH0"['$===']($case)) {statTestQuantile = self.context['$[]']("paramEstH0");
        return self.context['$[]']("alpha");}else if ("deltaH0"['$===']($case)) {statTestQuantile = self.context['$[]']("deltaEstH0");
        return self.context['$[]']("alpha");}else if ("paramEstLim"['$===']($case)) {statTestQuantile = self.context['$[]']("paramEstH0");
        return self.context['$[]']("paramPval");}else if ("deltaEstLim"['$===']($case)) {statTestQuantile = self.context['$[]']("deltaEstH0");
        return self.context['$[]']("deltaPval");}else {return self.alpha}})();
        param = (function() {$case = self.statTest.$typeStatTest();if ("dp0"['$===']($case) || "dm0"['$===']($case) || "dp1"['$===']($case) || "dm1"['$===']($case)) {return self.statTest.$paramsFrame()['$[]'](0).$paramsFrame()['$[]'](1)}else {return self.statTest.$paramsFrame()['$[]'](1)}})();
        return (function() {$case = side;if (">"['$===']($case)) {if ((($a = $rb_gt(param, self.context['$[]']("ref"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.sides = [statTestQuantile.$distrib().$quantile($rb_minus(1, alpha)), nil]
          } else {
          return self.sides = [nil, statTestQuantile.$distrib().$quantile($rb_minus(1, alpha))]
        }}else if ("<"['$===']($case)) {if ((($a = $rb_lt(param, self.context['$[]']("ref"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.sides = [nil, statTestQuantile.$distrib().$quantile(alpha)]
          } else {
          return self.sides = [statTestQuantile.$distrib().$quantile(alpha), nil]
        }}else if ("!="['$===']($case)) {if ((($a = $rb_lt(Math.abs($rb_minus(param, self.context['$[]']("ref"))), 0.0001)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.sides = [statTestQuantile.$distrib().$quantile($rb_divide(alpha, 2.0)), statTestQuantile.$distrib().$quantile($rb_minus(1, $rb_divide(alpha, 2.0)))]
          } else {
          return self.sides = ["between", statTestQuantile.$distrib().$quantile($rb_divide(alpha, 2.0)), statTestQuantile.$distrib().$quantile($rb_minus(1, $rb_divide(alpha, 2.0)))]
        }}else { return nil }})();
      }, TMP_337.$$arity = 0);

      Opal.defn(self, '$draw', TMP_339 = function $$draw() {
        var $a, $b, TMP_338, self = this, style = nil, graph = nil;

        self.$getSides();
        if (self.sides.$length()['$=='](3)) {
          self.statTest.$drawAreaSide(self.sides['$[]']($range(1, -1, false)), "between", self.shapes['$[]'](0), style = self.style, graph = self.graph);
          return self.shapes['$[]'](1).graphics.c();
          } else {
          return ($a = ($b = self.sides).$each_with_index, $a.$$p = (TMP_338 = function(side, i){var self = TMP_338.$$s || this;
            if (self.statTest == null) self.statTest = nil;
            if (self.shapes == null) self.shapes = nil;
            if (self.style == null) self.style = nil;
            if (self.graph == null) self.graph = nil;
if (side == null) side = nil;if (i == null) i = nil;
          if (side !== false && side !== nil && side != null) {
              return self.statTest.$drawAreaSide(side, ((function() {if (i['$=='](0)) {
                return "left"
                } else {
                return "right"
              }; return nil; })()), self.shapes['$[]'](i), style = self.style, graph = self.graph)
              } else {
              return self.shapes['$[]'](i).graphics.c();
            }}, TMP_338.$$s = self, TMP_338.$$arity = 2, TMP_338), $a).call($b)
        };
      }, TMP_339.$$arity = 0);

      Opal.defn(self, '$attachShapes', TMP_340 = function $$attachShapes() {
        var self = this;

        self.plot.$addChild(self.shapes['$[]'](0), [self, "draw"]);
        return self.plot.$addChild(self.shapes['$[]'](1), [self, "draw"]);
      }, TMP_340.$$arity = 0);

      return (Opal.defn(self, '$tooltipContent', TMP_341 = function $$tooltipContent(shape, evt) {
        var $a, $b, self = this, alpha = nil, $case = nil, statTestQuantile = nil, area = nil, param = nil, side = nil;

        alpha = (function() {$case = self.alpha;if ("context"['$===']($case)) {return self.context['$[]']("alpha")}else if ("paramH0"['$===']($case)) {statTestQuantile = self.context['$[]']("paramEstH0");
        return self.context['$[]']("alpha");}else if ("deltaH0"['$===']($case)) {statTestQuantile = self.context['$[]']("deltaEstH0");
        return self.context['$[]']("alpha");}else if ("paramEstLim"['$===']($case)) {statTestQuantile = self.context['$[]']("paramEstH0");
        return self.context['$[]']("paramPval");}else if ("deltaEstLim"['$===']($case)) {statTestQuantile = self.context['$[]']("deltaEstH0");
        return self.context['$[]']("deltaPval");}else {return self.alpha}})();
        area = alpha;
        if ((($a = (($b = statTestQuantile !== false && statTestQuantile !== nil && statTestQuantile != null) ? self.statTest['$!='](statTestQuantile) : statTestQuantile)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          param = (function() {$case = self.statTest.$typeStatTest();if ("dp0"['$===']($case) || "dm0"['$===']($case) || "dp1"['$===']($case) || "dm1"['$===']($case)) {return self.statTest.$paramsFrame()['$[]'](0).$paramsFrame()['$[]'](1)}else {return self.statTest.$paramsFrame()['$[]'](1)}})();
          side = (function() {if (self.side['$==']("context")) {
            return self.context['$[]']("side")
            } else {
            return self.side
          }; return nil; })();
          area = (function() {$case = side;if (">"['$===']($case)) {if ((($a = $rb_gt(param, self.context['$[]']("ref"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile($rb_minus(1, alpha)))
            } else {
            return $rb_minus(1, self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile($rb_minus(1, alpha))))
          }}else if ("<"['$===']($case)) {if ((($a = $rb_lt(param, self.context['$[]']("ref"))) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return $rb_minus(1, self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile(alpha)))
            } else {
            return self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile(alpha))
          }}else if ("!="['$===']($case)) {if ((($a = $rb_lt(Math.abs($rb_minus(param, self.context['$[]']("ref"))), 0.0001)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
            return $rb_times(2, self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile($rb_divide(alpha, 2.0))))
            } else {
            return $rb_minus(self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile($rb_minus(1, $rb_divide(alpha, 2.0)))), self.statTest.$distrib().$cdf(statTestQuantile.$distrib().$quantile($rb_divide(alpha, 2.0))))
          }}else { return nil }})();};
        return $rb_plus(($rb_times(area, 100)).$to_s(), "%");
      }, TMP_341.$$arity = 2), nil) && 'tooltipContent';
    })($scope.base, $scope.get('Child'));

    (function($base, $super) {
      function $Play(){};
      var self = $Play = $klass($base, $super, 'Play', $Play);

      var def = self.$$proto, $scope = self.$$scope, TMP_342, TMP_343, TMP_344, TMP_345, TMP_347, TMP_348, TMP_349, TMP_350;

      def.plotParam = def.plotDelta = def.paramEst = def.deltaEst = def.context = def.paramLim = def.deltaLim = def.paramTypeIRisk = def.deltaTypeIRisk = def.paramTypeGenRisk = def.deltaTypeGenRisk = def.paramEstLim = def.deltaEstLim = def.paramPvalRisk = def.deltaPvalRisk = def.styles = def.alpha = def.graphParam = def.graphDelta = nil;
      self.$attr_accessor("exp");

      Opal.defn(self, '$initialize', TMP_342 = function $$initialize(plotParam, plotDelta) {
        var $a, $b, $c, $d, self = this;

        if (plotParam == null) {
          plotParam = cqlsHypo.s.plot;
        }
        if (plotDelta == null) {
          plotDelta = cqlsHypo.h.plot;
        }
        self.stage = cqlsHypo.m.stage;
        $a = [plotParam, plotDelta], self.plotParam = $a[0], self.plotDelta = $a[1], $a;
        $a = [self.plotParam.$graph(), self.plotDelta.$graph()], self.graphParam = $a[0], self.graphDelta = $a[1], $a;
        self.$setStyles();
        self.paramEst = [$scope.get('StatTestCurve').$new("p", [1000, 0.15], false), $scope.get('StatTestCurve').$new("p", [1000, 0.2])];
        self.plotParam.$addChild(self.paramEst['$[]'](0));
        self.plotParam.$addChild(self.paramEst['$[]'](1));
        self.paramEst['$[]'](1).$style()['$[]=']("fill", createjs.Graphics.getRGB(200,200,200,.3));
        self.paramEst['$[]'](1).$style()['$[]=']("thickness", 1);
        self.deltaEst = [$scope.get('StatTestCurve').$new("dp0", [self.paramEst['$[]'](0)], false), $scope.get('StatTestCurve').$new("dp1", [self.paramEst['$[]'](1), 0.15], false)];
        self.plotDelta.$addChild(self.deltaEst['$[]'](0));
        self.plotDelta.$addChild(self.deltaEst['$[]'](1));
        self.deltaEst['$[]'](1).$style()['$[]=']("fill", createjs.Graphics.getRGB(200,200,200,.3));
        self.deltaEst['$[]'](1).$style()['$[]=']("thickness", 1);
        self.context = $hash2([], {});
        self.paramLim = $scope.get('AcceptanceRegion').$new(self.paramEst['$[]'](0), self.context);
        self.deltaLim = $scope.get('AcceptanceRegion').$new(self.deltaEst['$[]'](0), self.context);
        self.paramLim.$setPlot(self.plotParam);
        self.deltaLim.$setPlot(self.plotDelta);
        self.paramTypeIRisk = $scope.get('AreaRisk').$new(self.paramEst['$[]'](0), self.context);
        self.deltaTypeIRisk = $scope.get('AreaRisk').$new(self.deltaEst['$[]'](0), self.context);
        self.paramTypeIRisk.$setPlot(self.plotParam);
        self.deltaTypeIRisk.$setPlot(self.plotDelta);
        self.paramTypeGenRisk = $scope.get('AreaRisk').$new(self.paramEst['$[]'](1), self.context);
        (($a = ["paramH0"]), $b = self.paramTypeGenRisk, $b['$alpha='].apply($b, $a), $a[$a.length-1]);
        self.paramTypeGenRisk.$setPlot(self.plotParam);
        self.deltaTypeGenRisk = $scope.get('AreaRisk').$new(self.deltaEst['$[]'](1), self.context);
        (($a = ["deltaH0"]), $b = self.deltaTypeGenRisk, $b['$alpha='].apply($b, $a), $a[$a.length-1]);
        self.deltaTypeGenRisk.$setPlot(self.plotDelta);
        self.paramEstLim = $scope.get('AcceptanceRegion').$new(self.paramEst['$[]'](0), self.context);
        (($a = ["paramPval"]), $b = self.paramEstLim, $b['$alpha='].apply($b, $a), $a[$a.length-1]);
        self.deltaEstLim = $scope.get('AcceptanceRegion').$new(self.deltaEst['$[]'](0), self.context);
        (($a = ["deltaPval"]), $b = self.deltaEstLim, $b['$alpha='].apply($b, $a), $a[$a.length-1]);
        self.paramEstLim.$setPlot(self.plotParam);
        self.deltaEstLim.$setPlot(self.plotDelta);
        self.paramPvalRisk = $scope.get('AreaRisk').$new(self.paramEst['$[]'](0), self.context);
        (($a = ["paramEstLim"]), $b = self.paramPvalRisk, $b['$alpha='].apply($b, $a), $a[$a.length-1]);
        self.deltaPvalRisk = $scope.get('AreaRisk').$new(self.deltaEst['$[]'](0), self.context);
        (($a = ["deltaEstLim"]), $b = self.deltaPvalRisk, $b['$alpha='].apply($b, $a), $a[$a.length-1]);
        self.paramPvalRisk.$setPlot(self.plotParam);
        self.deltaPvalRisk.$setPlot(self.plotDelta);
        (($a = [(($c = [self.styles['$[]']("lim")]), $d = self.deltaLim, $d['$style='].apply($d, $c), $c[$c.length-1])]), $b = self.paramLim, $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [(($c = [self.styles['$[]']("estLim")]), $d = self.deltaEstLim, $d['$style='].apply($d, $c), $c[$c.length-1])]), $b = self.paramEstLim, $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [(($c = [self.styles['$[]']("estLim")]), $d = self.deltaPvalRisk, $d['$style='].apply($d, $c), $c[$c.length-1])]), $b = self.paramPvalRisk, $b['$style='].apply($b, $a), $a[$a.length-1]);
        self.paramLim.$initEvents();
        self.paramLim.$addCallable([self.paramTypeIRisk, "draw"]);
        self.paramLim.$addCallable([self.paramTypeGenRisk, "draw"]);
        self.paramLim.$addCallable([self.deltaLim, "draw"]);
        self.paramLim.$addCallable([self.deltaTypeIRisk, "draw"]);
        self.paramLim.$addCallable([self.deltaTypeGenRisk, "draw"]);
        self.deltaLim.$initEvents();
        self.deltaLim.$addCallable([self.deltaTypeIRisk, "draw"]);
        self.deltaLim.$addCallable([self.deltaTypeGenRisk, "draw"]);
        self.deltaLim.$addCallable([self.paramLim, "draw"]);
        self.deltaLim.$addCallable([self.paramTypeIRisk, "draw"]);
        self.deltaLim.$addCallable([self.paramTypeGenRisk, "draw"]);
        self.paramEst['$[]'](0).$initEvents(["sd"]);
        self.paramEst['$[]'](0).$addCallable([self.paramEst['$[]'](1), "paramsFrameAtFrom", [2, self.paramEst['$[]'](0)]], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramEst['$[]'](1), "updateStatTestDistrib"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramEst['$[]'](1), "draw"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramEst['$[]'](1), "drawSD"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramLim, "draw"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramTypeIRisk, "draw"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramTypeGenRisk, "draw"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.deltaEst['$[]'](1), "updateStatTestDistrib"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.deltaEst['$[]'](1), "draw"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.deltaEst['$[]'](1), "drawMean"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.deltaEst['$[]'](1), "drawSD"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.deltaTypeGenRisk, "draw"], "sd");
        self.paramEst['$[]'](0).$addCallable([self, "setPval"], "sd");
        self.paramEst['$[]'](0).$addCallable([self.paramPvalRisk, "draw"], "sd");
        self.paramEst['$[]'](1).$initEvents();
        self.paramEst['$[]'](1).$addCallable([self.paramTypeGenRisk, "draw"]);
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "updateStatTestDistrib"]);
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "draw"]);
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "drawMean"]);
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "drawSD"]);
        self.paramEst['$[]'](1).$addCallable([self.deltaTypeGenRisk, "draw"]);
        self.paramEst['$[]'](1).$addCallable([self.paramEst['$[]'](0), "paramsFrameAtFrom", [2, self.paramEst['$[]'](1)]], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramEst['$[]'](0), "updateStatTestDistrib"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramEst['$[]'](0), "draw"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramEst['$[]'](0), "drawSD"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramLim, "draw"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramTypeIRisk, "draw"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramTypeGenRisk, "draw"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "updateStatTestDistrib"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "draw"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "drawMean"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.deltaEst['$[]'](1), "drawSD"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.deltaTypeGenRisk, "draw"], "sd");
        self.paramEst['$[]'](1).$addCallable([self, "setPval"], "sd");
        self.paramEst['$[]'](1).$addCallable([self.paramPvalRisk, "draw"], "sd");
        self.paramLim.$attachShapes();
        self.deltaLim.$attachShapes();
        self.paramTypeIRisk.$attachShapes();
        self.deltaTypeIRisk.$attachShapes();
        self.paramTypeGenRisk.$attachShapes();
        self.deltaTypeGenRisk.$attachShapes();
        self.paramEstLim.$attachShapes();
        self.deltaEstLim.$attachShapes();
        self.paramPvalRisk.$attachShapes();
        self.deltaPvalRisk.$attachShapes();
        self.paramEst['$[]'](0).$attachShapes();
        self.paramEst['$[]'](1).$attachShapes();
        self.deltaEst['$[]'](0).$attachShapes();
        self.deltaEst['$[]'](1).$attachShapes();
        self.plotParam.$attachAxis();
        self.plotDelta.$attachAxis();
        self.n01 = $scope.get('Distribution').$new("normal", [0, 1]);
        self.$setAlpha(0.05);
        self.$setStatMode("none");
        self.$reset();
        return self.style = $hash2(["fp", "sp", "fl", "sl", "fr", "sr"], {"fp": "#FFF", "sp": "#000000", "fl": "#FFF", "sl": "#000000", "fr": "rgba(100,100,255,0.8)", "sr": "#000000"});
      }, TMP_342.$$arity = -1);

      Opal.defn(self, '$setStyles', TMP_343 = function $$setStyles() {
        var $a, self = this;

        if ((($a = self.styles) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.styles = $hash2([], {})
        };
        self.styles['$[]=']("estLim", $hash2(["fill", "stroke", "thickness"], {"fill": "rgba(240,130,40,.3)", "stroke": "rgba(240,130,40,.8)", "thickness": 6}));
        self.styles['$[]=']("known", $hash2(["close", "fill", "stroke", "thickness"], {"close": true, "fill": "rgba(50,100,250,.1)", "stroke": "rgba(50,150,250,.8)", "thickness": 3}));
        self.styles['$[]=']("knownMovable", $hash2(["close", "fill", "stroke", "thickness"], {"close": true, "fill": "rgba(50,100,250,.1)", "stroke": "rgba(50,150,250,.8)", "thickness": 6}));
        self.styles['$[]=']("unknown", $hash2(["close", "fill", "stroke", "thickness"], {"close": true, "fill": "rgba(250,50,100,.1)", "stroke": "rgba(250,50,100,.8)", "thickness": 3}));
        self.styles['$[]=']("unknownMovable", $hash2(["close", "fill", "stroke", "thickness"], {"close": true, "fill": "rgba(250,50,100,.1)", "stroke": "rgba(250,50,100,.8)", "thickness": 6}));
        return self.styles['$[]=']("lim", $hash2(["close", "fill", "stroke", "thickness"], {"close": true, "fill": "rgba(20,150,20,.1)", "stroke": "rgba(20,150,20,.8)", "thickness": 6}));
      }, TMP_343.$$arity = 0);

      Opal.defn(self, '$setPval', TMP_344 = function $$setPval() {
        var self = this;

        self.context['$[]=']("paramPval", self.context['$[]']("paramEstH0").$distrib().$cdf(self.context['$[]']("paramEstLim")));
        self.context['$[]=']("deltaPval", self.context['$[]']("deltaEstH0").$distrib().$cdf(self.context['$[]']("deltaEstLim")));
        if (self.context['$[]']("side")['$=='](">")) {
          self.context['$[]=']("paramPval", $rb_minus(1, self.context['$[]']("paramPval")));
          return self.context['$[]=']("deltaPval", $rb_minus(1, self.context['$[]']("deltaPval")));
        } else if (self.context['$[]']("side")['$==']("!=")) {
          self.context['$[]=']("paramPval", $rb_times(2, [self.context['$[]']("paramPval"), $rb_minus(1, self.context['$[]']("paramPval"))].$min()));
          return self.context['$[]=']("deltaPval", $rb_times(2, [self.context['$[]']("deltaPval"), $rb_minus(1, self.context['$[]']("deltaPval"))].$min()));
          } else {
          return nil
        };
      }, TMP_344.$$arity = 0);

      Opal.defn(self, '$getContext', TMP_345 = function $$getContext() {
        var $a, $b, self = this, $case = nil, sd = nil;

        self.context['$[]=']("param", cqlsHypo.f.getValue('param'));
        self.context['$[]=']("side", cqlsHypo.f.getValue('side'));
        self.context['$[]=']("ref", parseFloat(cqlsHypo.f.getValue('refValue')));
        self.context['$[]=']("n", parseInt(cqlsHypo.f.getValue('nValue')));
        self.context['$[]=']("alpha", self.alpha);
        self.context['$[]=']("sigma", 1);
        console.log('param:' + self.context['$[]']("param"));
        $case = self.context['$[]']("param");if ("p"['$===']($case)) {(($a = [[self.context['$[]']("n"), self.context['$[]']("ref")]]), $b = self.paramEst['$[]'](0), $b['$paramsFrame='].apply($b, $a), $a[$a.length-1]);
        (($a = [[self.context['$[]']("n"), $rb_times(self.context['$[]']("ref").$to_f(), ((function() {if (self.context['$[]']("side")['$==']("<")) {
          return 0.5
          } else {
          return 1.5
        }; return nil; })()))]]), $b = self.paramEst['$[]'](1), $b['$paramsFrame='].apply($b, $a), $a[$a.length-1]);
        self.context['$[]=']("paramEstLim", parseFloat(cqlsHypo.f.getValue('meanValue')));
        self.context['$[]=']("deltaEstLim", $rb_divide(($rb_minus(self.context['$[]']("paramEstLim"), self.context['$[]']("ref"))), (Math.sqrt($rb_divide($rb_times(self.context['$[]']("ref"), ($rb_minus(1, self.context['$[]']("ref")))), self.context['$[]']("n"))))));}else if ("mu"['$===']($case)) {self.context['$[]=']("param", "m");
        (($a = [[self.context['$[]']("n"), self.context['$[]']("ref"), self.context['$[]']("sigma")]]), $b = self.paramEst['$[]'](0), $b['$paramsFrame='].apply($b, $a), $a[$a.length-1]);
        (($a = [[self.context['$[]']("n"), $rb_times(self.context['$[]']("ref").$to_f(), ((function() {if (self.context['$[]']("side")['$==']("<")) {
          return 0.5
          } else {
          return 1.5
        }; return nil; })())), self.context['$[]']("sigma")]]), $b = self.paramEst['$[]'](1), $b['$paramsFrame='].apply($b, $a), $a[$a.length-1]);
        self.context['$[]=']("paramEstLim", parseFloat(cqlsHypo.f.getValue('meanValue')));
        sd = parseFloat(cqlsHypo.f.getValue('sdValue'));
        self.context['$[]=']("deltaEstLim", $rb_divide(($rb_minus(self.context['$[]']("paramEstLim"), self.context['$[]']("ref"))), ($rb_divide(sd, Math.sqrt(self.context['$[]']("n"))))));};
        (($a = [self.context['$[]']("param")]), $b = self.paramEst['$[]'](0), $b['$typeStatTest='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.context['$[]']("param")]), $b = self.paramEst['$[]'](1), $b['$typeStatTest='].apply($b, $a), $a[$a.length-1]);
        self.context['$[]=']("paramEstH0", self.paramEst['$[]'](0));
        self.context['$[]=']("deltaEstH0", self.deltaEst['$[]'](0));
        (($a = [$rb_plus($rb_plus("d", self.context['$[]']("param")), "0")]), $b = self.deltaEst['$[]'](0), $b['$typeStatTest='].apply($b, $a), $a[$a.length-1]);
        (($a = [$rb_plus($rb_plus("d", self.context['$[]']("param")), "1")]), $b = self.deltaEst['$[]'](1), $b['$typeStatTest='].apply($b, $a), $a[$a.length-1]);
        self.paramEst['$[]'](1).$updateStatTestDistrib();
        self.paramEst['$[]'](0).$updateStatTestDistrib();
        self.deltaEst['$[]'](1).$updateStatTestDistrib();
        self.$setPval();
        return (function() {$case = self.context['$[]']("param");if ("p"['$===']($case)) {(($a = [self.styles['$[]']("known")]), $b = self.paramEst['$[]'](0), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.paramEst['$[]'](0), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.paramEst['$[]'](0), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknown")]), $b = self.paramEst['$[]'](1), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknownMovable")]), $b = self.paramEst['$[]'](1), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknownMovable")]), $b = self.paramEst['$[]'](1), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.deltaEst['$[]'](0), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.deltaEst['$[]'](0), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.deltaEst['$[]'](0), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknown")]), $b = self.deltaEst['$[]'](1), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknown")]), $b = self.deltaEst['$[]'](1), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        return (($a = [self.styles['$[]']("unknown")]), $b = self.deltaEst['$[]'](1), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);}else if ("m"['$===']($case)) {(($a = [self.styles['$[]']("unknown")]), $b = self.paramEst['$[]'](0), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.paramEst['$[]'](0), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknownMovable")]), $b = self.paramEst['$[]'](0), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknown")]), $b = self.paramEst['$[]'](1), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknownMovable")]), $b = self.paramEst['$[]'](1), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknownMovable")]), $b = self.paramEst['$[]'](1), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.deltaEst['$[]'](0), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.deltaEst['$[]'](0), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("known")]), $b = self.deltaEst['$[]'](0), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknown")]), $b = self.deltaEst['$[]'](1), $b['$style='].apply($b, $a), $a[$a.length-1]);
        (($a = [self.styles['$[]']("unknown")]), $b = self.deltaEst['$[]'](1), $b['$meanStyle='].apply($b, $a), $a[$a.length-1]);
        return (($a = [self.styles['$[]']("unknown")]), $b = self.deltaEst['$[]'](1), $b['$sdStyle='].apply($b, $a), $a[$a.length-1]);}else { return nil }})();
      }, TMP_345.$$arity = 0);

      Opal.defn(self, '$reset', TMP_347 = function $$reset(curs) {
        var $a, $b, TMP_346, self = this;

        if (curs == null) {
          curs = [0, 1];
        }
        self.$getContext();
        (($a = [["curve0", "curve1"]]), $b = self.graphParam, $b['$active='].apply($b, $a), $a[$a.length-1]);
        self.graphParam.$update();
        self.plotParam.$update();
        (($a = [["curve2", "curve3"]]), $b = self.graphDelta, $b['$active='].apply($b, $a), $a[$a.length-1]);
        self.graphDelta.$update();
        self.plotDelta.$update();
        ($a = ($b = curs).$each, $a.$$p = (TMP_346 = function(cur){var self = TMP_346.$$s || this;
          if (self.paramEst == null) self.paramEst = nil;
          if (self.deltaEst == null) self.deltaEst = nil;
if (cur == null) cur = nil;
        self.paramEst['$[]'](cur).$draw();
          return self.deltaEst['$[]'](cur).$draw();}, TMP_346.$$s = self, TMP_346.$$arity = 1, TMP_346), $a).call($b);
        return self.$updateVisible();
      }, TMP_347.$$arity = -1);

      Opal.defn(self, '$setStatMode', TMP_348 = function $$setStatMode(mode) {
        var self = this;

        return self.statMode = ((function() {if (mode['$==']("meanIC")) {
          return "ic"
          } else {
          return "none"
        }; return nil; })());
      }, TMP_348.$$arity = 1);

      Opal.defn(self, '$setAlpha', TMP_349 = function $$setAlpha(alpha) {
        var self = this;

        return self.alpha = alpha;
      }, TMP_349.$$arity = 1);

      return (Opal.defn(self, '$updateVisible', TMP_350 = function $$updateVisible() {
        var self = this;

        
				self.paramEst['$[]'](0).shape.visible=cqlsHypo.f.getValue('checkParam0Curve');
				self.paramEst['$[]'](1).shape.visible=cqlsHypo.f.getValue('checkParam1Curve');
				self.deltaEst['$[]'](0).shape.visible=cqlsHypo.f.getValue('checkDelta0Curve');
				self.deltaEst['$[]'](1).shape.visible=cqlsHypo.f.getValue('checkDelta1Curve');


				// Lim
				self.paramLim.shapes[0].visible= cqlsHypo.f.getValue('checkParamLim');
				self.paramLim.shapes[1].visible= cqlsHypo.f.getValue('checkParamLim');
				self.deltaLim.shapes[0].visible= cqlsHypo.f.getValue('checkDeltaLim');
				self.deltaLim.shapes[1].visible= cqlsHypo.f.getValue('checkDeltaLim');
				self.paramEstLim.shapes[0].visible= cqlsHypo.f.getValue('checkData');
				self.paramEstLim.shapes[1].visible= cqlsHypo.f.getValue('checkData');
				self.deltaEstLim.shapes[0].visible= cqlsHypo.f.getValue('checkData') & (cqlsHypo.f.getValue('checkDelta0Mean') | cqlsHypo.f.getValue('checkDeltaLim'));
				self.deltaEstLim.shapes[1].visible= cqlsHypo.f.getValue('checkData') & (cqlsHypo.f.getValue('checkDelta0Mean') | cqlsHypo.f.getValue('checkDeltaLim'));

				//Risk
				self.paramTypeIRisk.shapes[0].visible= cqlsHypo.f.getValue('checkRiskTypeI') & cqlsHypo.f.getValue('checkParam0Curve');
				self.paramTypeIRisk.shapes[1].visible= cqlsHypo.f.getValue('checkRiskTypeI') & cqlsHypo.f.getValue('checkParam0Curve');
				self.deltaTypeIRisk.shapes[0].visible= cqlsHypo.f.getValue('checkRiskTypeI') & cqlsHypo.f.getValue('checkDelta0Curve');
				self.deltaTypeIRisk.shapes[1].visible= cqlsHypo.f.getValue('checkRiskTypeI') & cqlsHypo.f.getValue('checkDelta0Curve');

				self.paramTypeGenRisk.shapes[0].visible= cqlsHypo.f.getValue('checkRiskTypeGen') & cqlsHypo.f.getValue('checkParam1Curve');
				self.paramTypeGenRisk.shapes[1].visible= cqlsHypo.f.getValue('checkRiskTypeGen') & cqlsHypo.f.getValue('checkParam1Curve');
				self.deltaTypeGenRisk.shapes[0].visible= cqlsHypo.f.getValue('checkRiskTypeGen') & cqlsHypo.f.getValue('checkDelta1Curve');
				self.deltaTypeGenRisk.shapes[1].visible= cqlsHypo.f.getValue('checkRiskTypeGen') & cqlsHypo.f.getValue('checkDelta1Curve');

				self.paramPvalRisk.shapes[0].visible= cqlsHypo.f.getValue('checkPval') & cqlsHypo.f.getValue('checkParam0Curve');
				self.paramPvalRisk.shapes[1].visible= cqlsHypo.f.getValue('checkPval') & cqlsHypo.f.getValue('checkParam0Curve');
				self.deltaPvalRisk.shapes[0].visible= cqlsHypo.f.getValue('checkPval') & cqlsHypo.f.getValue('checkDelta0Curve');
				self.deltaPvalRisk.shapes[1].visible= cqlsHypo.f.getValue('checkPval') & cqlsHypo.f.getValue('checkDelta0Curve');


				self.paramEst['$[]'](0).summaryShapes[0].visible=cqlsHypo.f.getValue('checkParam0Mean');
				self.paramEst['$[]'](0).summaryShapes[1].visible=cqlsHypo.f.getValue('checkParam0SD');
				self.paramEst['$[]'](1).summaryShapes[0].visible=cqlsHypo.f.getValue('checkParam1Mean');
				self.paramEst['$[]'](1).summaryShapes[1].visible=cqlsHypo.f.getValue('checkParam1SD');

				self.deltaEst['$[]'](0).summaryShapes[0].visible=cqlsHypo.f.getValue('checkDelta0Mean');
				self.deltaEst['$[]'](0).summaryShapes[1].visible=cqlsHypo.f.getValue('checkDelta0SD');
				self.deltaEst['$[]'](1).summaryShapes[0].visible=cqlsHypo.f.getValue('checkDelta1Mean');
				self.deltaEst['$[]'](1).summaryShapes[1].visible=cqlsHypo.f.getValue('checkDelta1SD');

				// update stage since possible change of visibility
				cqlsHypo.m.stage.update();
			;
      }, TMP_350.$$arity = 0), nil) && 'updateVisible';
    })($scope.base, null);

    (function($base, $super) {
      function $Distribution(){};
      var self = $Distribution = $klass($base, $super, 'Distribution', $Distribution);

      var def = self.$$proto, $scope = self.$$scope, TMP_351, TMP_352, TMP_354, TMP_355, TMP_356, TMP_360, TMP_361, TMP_362, TMP_363, TMP_365, TMP_366, TMP_367, TMP_368, TMP_369, TMP_370, TMP_371, TMP_372, TMP_373, TMP_374;

      def.list = def.name = def.params = def.originalDistrib = def.type = def.distrib = nil;
      self.$attr_accessor("list", "name", "params", "distrib");

      Opal.defn(self, '$initialize', TMP_351 = function $$initialize(name, params, transf) {
        var $a, $b, self = this;

        if (name == null) {
          name = nil;
        }
        if (params == null) {
          params = [];
        }
        if (transf == null) {
          transf = nil;
        }
        if ((($a = (($b = Opal.cvars['@@list']) == null ? nil : $b)) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@list'] = $hash2(["uniform", "normal", "t", "chi2", "exp", "cauchy", "discreteUniform", "bernoulli", "binomial", "birthday", "mean", "sum", "locationScale", "square", "sumOfSq"], {"uniform": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["UniformDistribution"], "qbounds": [0, 1]}), "normal": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["NormalDistribution"], "qbounds": [cqlsHypo.m.qmin, cqlsHypo.m.qmax]}), "t": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["StudentDistribution"], "qbounds": [cqlsHypo.m.qmin, cqlsHypo.m.qmax]}), "chi2": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["ChiSquareDistribution"], "qbounds": [0, cqlsHypo.m.qmax]}), "exp": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["ExponentialDistribution"], "qbounds": [0, cqlsHypo.m.qmax]}), "cauchy": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["CauchyDistribution"], "qbounds": [0.01, 0.99]}), "discreteUniform": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["DiscreteUniformDistribution"], "qbounds": [0, 1]}), "bernoulli": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BernoulliDistribution"], "qbounds": [0, 1]}), "binomial": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BinomialDistribution"], "qbounds": [0, 1]}), "birthday": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BirthdayDistribution"], "qbounds": [0.01, 1]}), "mean": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "sum": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "locationScale": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "square": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "sumOfSq": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]})}))
        };
        self.list = (($a = Opal.cvars['@@list']) == null ? nil : $a);
        if (name !== false && name !== nil && name != null) {
          if (transf !== false && transf !== nil && transf != null) {
            return self.$setAsTransfOf($scope.get('Distribution').$new(name, params), transf)
            } else {
            return self.$set(name, params)
          }
          } else {
          return nil
        };
      }, TMP_351.$$arity = -1);

      Opal.defn(self, '$set', TMP_352 = function $$set(dist, params) {
        var $a, self = this, instr = nil;

        $a = [dist, params], self.name = $a[0], self.params = $a[1], $a;
        self.type = self.list['$[]'](self.name)['$[]']("type");
        instr = $rb_plus($rb_plus($rb_plus($rb_plus("new ", self.list['$[]'](self.name)['$[]']("dist").$join(".")), "("), self.params.$join(",")), ");");
        return self.distrib = eval(instr);
      }, TMP_352.$$arity = 2);

      Opal.defn(self, '$setAsTransfOf', TMP_354 = function $$setAsTransfOf(dist, transf) {
        var $a, $b, TMP_353, self = this, $case = nil, d = nil;

        $a = [transf['$[]']("name"), transf['$[]']("args")], self.name = $a[0], self.params = $a[1], $a;
        self.originalDistrib = dist;
        return (function() {$case = self.name;if ("square"['$===']($case)) {return self.distrib = new PowerDistribution(self.originalDistrib.distrib,2)}else if ("mean"['$===']($case)) {d = new Convolution(self.originalDistrib.distrib,self.params['$[]'](0));
        return self.distrib = new LocationScaleDistribution(d,0,1/self.params['$[]'](0));}else if ("sum"['$===']($case)) {return self.distrib = new Convolution(self.originalDistrib.distrib,self.params['$[]'](0))}else if ("locationScale"['$===']($case)) {return self.distrib = new LocationScaleDistribution(self.originalDistrib.distrib,self.params['$[]'](0),self.params['$[]'](1))}else if ("sumOfSq"['$===']($case)) {d = new LocationScaleDistribution(self.originalDistrib.distrib,-self.originalDistrib.$mean()/self.originalDistrib.$stdDev(),1/self.originalDistrib.$stdDev());
        d = new PowerDistribution(d,2);
        if ((($a = d.type === CONT) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.distrib = new Convolution(d,self.params['$[]'](0))
          } else {
          self.distrib = $scope.get('Convolution').$power(d, self.params['$[]'](0));
          return self.$p(["boundsDistrib", self.$step(), self.$bounds(), self.$pdf(self.$bounds()), ($a = ($b = self.$pdf(self.$bounds())).$inject, $a.$$p = (TMP_353 = function(e, e2){var self = TMP_353.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = $rb_plus(e, e2)}, TMP_353.$$s = self, TMP_353.$$arity = 2, TMP_353), $a).call($b, 0)]);
        };}else { return nil }})();
      }, TMP_354.$$arity = 2);

      Opal.defn(self, '$type', TMP_355 = function $$type() {
        var $a, self = this;

        return ((($a = self.type) !== false && $a !== nil && $a != null) ? $a : self.originalDistrib.$type());
      }, TMP_355.$$arity = 0);

      Opal.defn(self, '$qbounds', TMP_356 = function $$qbounds() {
        var self = this;

        return self.list['$[]'](self.name)['$[]']("qbounds");
      }, TMP_356.$$arity = 0);

      Opal.defn(self, '$bounds', TMP_360 = function $$bounds() {
        var $a, $b, TMP_357, $c, $d, $e, TMP_358, TMP_359, self = this, qb = nil, $case = nil, a = nil, b = nil, s = nil;

        qb = (function() {if ((($a = self.originalDistrib) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.originalDistrib.$qbounds()
          } else {
          return self.$qbounds()
        }; return nil; })();
        return (function() {$case = self.$type();if ("cont"['$===']($case)) {return ($a = ($b = qb).$map, $a.$$p = (TMP_357 = function(e){var self = TMP_357.$$s || this;
if (e == null) e = nil;
        return self.$quantile(e)}, TMP_357.$$s = self, TMP_357.$$arity = 1, TMP_357), $a).call($b)}else if ("disc"['$===']($case)) {if ((($a = self['$regular?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          $c = ($d = ($e = qb).$map, $d.$$p = (TMP_358 = function(e){var self = TMP_358.$$s || this;
if (e == null) e = nil;
          return self.$quantile(e)}, TMP_358.$$s = self, TMP_358.$$arity = 1, TMP_358), $d).call($e), $a = Opal.to_ary($c), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]), $c;
          s = self.$step();
          return ($a = ($c = $scope.get('Range').$new(0, ($rb_divide(($rb_minus(b, a)), s))).$to_a()).$map, $a.$$p = (TMP_359 = function(e){var self = TMP_359.$$s || this;
if (e == null) e = nil;
          return $rb_plus(a, $rb_times(e, s))}, TMP_359.$$s = self, TMP_359.$$arity = 1, TMP_359), $a).call($c);
          } else {
          return self.distrib.values();
        }}else { return nil }})();
      }, TMP_360.$$arity = 0);

      Opal.defn(self, '$minValue', TMP_361 = function $$minValue() {
        var self = this;

        return self.distrib.minValue();
      }, TMP_361.$$arity = 0);

      Opal.defn(self, '$maxValue', TMP_362 = function $$maxValue() {
        var self = this;

        return self.distrib.maxValue();
      }, TMP_362.$$arity = 0);

      Opal.defn(self, '$regular?', TMP_363 = function() {
        var self = this;

        return self.distrib.regular();
      }, TMP_363.$$arity = 0);

      Opal.defn(self, '$step', TMP_365 = function $$step() {
        var $a, $b, TMP_364, self = this, b = nil;

        if ((($a = self['$regular?']()) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          return self.distrib.step();
          } else {
          b = self.$bounds();
          return ($a = ($b = ($range(1, b.$length(), true))).$map, $a.$$p = (TMP_364 = function(i){var self = TMP_364.$$s || this;
if (i == null) i = nil;
          return ($rb_minus(b['$[]'](i), b['$[]']($rb_minus(i, 1)))).$abs()}, TMP_364.$$s = self, TMP_364.$$arity = 1, TMP_364), $a).call($b).$min().$to_f();
        };
      }, TMP_365.$$arity = 0);

      Opal.defn(self, '$mean', TMP_366 = function $$mean() {
        var self = this;

        return self.distrib.mean();
      }, TMP_366.$$arity = 0);

      Opal.defn(self, '$mode', TMP_367 = function $$mode() {
        var self = this;

        return self.distrib.mode();
      }, TMP_367.$$arity = 0);

      Opal.defn(self, '$maxPdf', TMP_368 = function $$maxPdf() {
        var self = this;

        return self.distrib.maxDensity();
      }, TMP_368.$$arity = 0);

      Opal.defn(self, '$variance', TMP_369 = function $$variance() {
        var self = this;

        return self.distrib.variance();
      }, TMP_369.$$arity = 0);

      Opal.defn(self, '$stdDev', TMP_370 = function $$stdDev() {
        var self = this;

        return self.distrib.stdDev();
      }, TMP_370.$$arity = 0);

      Opal.defn(self, '$sample', TMP_371 = function $$sample(n) {
        var self = this;

        if (n == null) {
          n = 1;
        }
        z=[];for(i=0;i<n;i++) z[i]=self.distrib.simulate();return z
      }, TMP_371.$$arity = -1);

      Opal.defn(self, '$pdf', TMP_372 = function $$pdf(x) {
        var self = this;

        return x.map(function(e) {return self.distrib.density(e);});
      }, TMP_372.$$arity = 1);

      Opal.defn(self, '$cdf', TMP_373 = function $$cdf(x) {
        var self = this;

        return self.distrib.CDF(x);
      }, TMP_373.$$arity = 1);

      return (Opal.defn(self, '$quantile', TMP_374 = function $$quantile(alpha) {
        var self = this;

        return self.distrib.quantile(alpha);
      }, TMP_374.$$arity = 1), nil) && 'quantile';
    })($scope.base, null);

    (function($base, $super) {
      function $Convolution(){};
      var self = $Convolution = $klass($base, $super, 'Convolution', $Convolution);

      var def = self.$$proto, $scope = self.$$scope, TMP_376, TMP_377, TMP_378, TMP_383;

      def.b1 = def.bounds = nil;
      Opal.defs($scope.get('Convolution'), '$power', TMP_376 = function $$power(d, n) {
        var $a, $b, TMP_375, self = this, dist = nil, b = nil, dist2 = nil, b2 = nil;

        if ((($a = d instanceof Distribution) !== nil && $a != null && (!$a.$$is_boolean || $a == true))) {
          $a = [d, d.values()], dist = $a[0], b = $a[1], $a;
          $a = [d, d.values()], dist2 = $a[0], b2 = $a[1], $a;
          } else {
          $a = [d.$distrib(), d.$bounds()], dist = $a[0], b = $a[1], $a;
          $a = [d.$distrib(), d.$bounds()], dist2 = $a[0], b2 = $a[1], $a;
        };
        ($a = ($b = ($range(1, n, true))).$each, $a.$$p = (TMP_375 = function(i){var self = TMP_375.$$s || this;
if (i == null) i = nil;
        dist2 = new Convolution2(dist,dist2,b,b2);
          return b2 = dist2.values();}, TMP_375.$$s = self, TMP_375.$$arity = 1, TMP_375), $a).call($b);
        return dist2;
      }, TMP_376.$$arity = 2);

      Opal.defs($scope.get('Convolution'), '$two', TMP_377 = function $$two(d, d2) {
        var $a, self = this, dist = nil, b = nil, dist2 = nil, b2 = nil;

        $a = [d.$distrib(), d.$bounds()], dist = $a[0], b = $a[1], $a;
        $a = [d2.$distrib(), d2.$bounds()], dist2 = $a[0], b2 = $a[1], $a;
        return new Convolution2(dist,dist2,b,b2);
      }, TMP_377.$$arity = 2);

      Opal.defn(self, '$initialize', TMP_378 = function $$initialize(d1, d2, b1, b2) {
        var $a, self = this;

        $a = [d1, d2, b1, b2], self.d1 = $a[0], self.d2 = $a[1], self.b1 = $a[2], self.b2 = $a[3], $a;
        return self.$prepare();
      }, TMP_378.$$arity = 4);

      return (Opal.defn(self, '$prepare', TMP_383 = function $$prepare() {
        var $a, $b, TMP_379, $c, TMP_381, self = this, ind = nil;

        ind = $hash2([], {});
        ($a = ($b = self.b1).$each_with_index, $a.$$p = (TMP_379 = function(v1, i1){var self = TMP_379.$$s || this, $c, $d, TMP_380;
          if (self.b2 == null) self.b2 = nil;
if (v1 == null) v1 = nil;if (i1 == null) i1 = nil;
        return ($c = ($d = self.b2).$each_with_index, $c.$$p = (TMP_380 = function(v2, i2){var self = TMP_380.$$s || this, $e, v = nil;
if (v2 == null) v2 = nil;if (i2 == null) i2 = nil;
          v = $scope.get('CqlsHypo').$quantize($rb_plus(v1, v2));
            if ((($e = ind.$keys()['$include?'](v)) !== nil && $e != null && (!$e.$$is_boolean || $e == true))) {
              return ind['$[]'](v)['$<<']([i1, i2])
              } else {
              return ind['$[]='](v, [[i1, i2]])
            };}, TMP_380.$$s = self, TMP_380.$$arity = 2, TMP_380), $c).call($d)}, TMP_379.$$s = self, TMP_379.$$arity = 2, TMP_379), $a).call($b);
        self.bounds = ind.$keys().$sort();
        self.pdf = [];
        return ($a = ($c = self.bounds).$each_with_index, $a.$$p = (TMP_381 = function(v, i){var self = TMP_381.$$s || this, $d, $e, TMP_382;
          if (self.pdf == null) self.pdf = nil;
if (v == null) v = nil;if (i == null) i = nil;
        self.pdf['$[]='](i, 0);
          return ($d = ($e = ind['$[]'](v)).$each, $d.$$p = (TMP_382 = function(j1, j2){var self = TMP_382.$$s || this, $f, $g;
            if (self.pdf == null) self.pdf = nil;
            if (self.d1 == null) self.d1 = nil;
            if (self.b1 == null) self.b1 = nil;
            if (self.d2 == null) self.d2 = nil;
            if (self.b2 == null) self.b2 = nil;
if (j1 == null) j1 = nil;if (j2 == null) j2 = nil;
          return ($f = i, $g = self.pdf, $g['$[]=']($f, $rb_plus($g['$[]']($f), self.d1.density(self.b1['$[]'](j1))* self.d2.density(self.b2['$[]'](j2)))))}, TMP_382.$$s = self, TMP_382.$$arity = 2, TMP_382), $d).call($e);}, TMP_381.$$s = self, TMP_381.$$arity = 2, TMP_381), $a).call($c);
      }, TMP_383.$$arity = 0), nil) && 'prepare';
    })($scope.base, null);

    Opal.cdecl($scope, 'PREC4DISC', 0);

    Opal.defs($scope.get('CqlsHypo'), '$quantize', TMP_384 = function $$quantize(x, prec) {
      var self = this;

      if (prec == null) {
        prec = $scope.get('PREC4DISC');
      }
      return parseFloat(x.toFixed(prec));
    }, TMP_384.$$arity = -2);

    Opal.defs($scope.get('CqlsHypo'), '$equal', TMP_385 = function $$equal(a, b) {
      var self = this;

      return a.toFixed($scope.get('PREC4DISC'))===b.toFixed($scope.get('PREC4DISC'));
    }, TMP_385.$$arity = 2);

    Opal.defs($scope.get('CqlsHypo'), '$range', TMP_386 = function $$range(low, high, step) {
      var self = this;

      
			// From: http://phpjs.org/functions
			// +   original by: Waldo Malqui Silva
			// *     example 1: range ( 0, 12 );
			// *     returns 1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
			// *     example 2: range( 0, 100, 10 );
			// *     returns 2: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
			// *     example 3: range( 'a', 'i' );
			// *     returns 3: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
			// *     example 4: range( 'c', 'a' );
			// *     returns 4: ['c', 'b', 'a']
			var matrix = [];
			var inival, endval, plus;
			var walker = step || 1;
			var chars = false;

			if (!isNaN(low) && !isNaN(high)) {
			inival = low;
			endval = high;
			} else if (isNaN(low) && isNaN(high)) {
			chars = true;
			inival = low.charCodeAt(0);
			endval = high.charCodeAt(0);
			} else {
			inival = (isNaN(low) ? 0 : low);
			endval = (isNaN(high) ? 0 : high);
			}

			plus = ((inival > endval) ? false : true);
			if (plus) {
			while (inival <= endval) {
			  matrix.push(((chars) ? String.fromCharCode(inival) : inival));
			  inival += walker;
			}
			} else {
			while (inival >= endval) {
			  matrix.push(((chars) ? String.fromCharCode(inival) : inival));
			  inival -= walker;
			}
			}

			return matrix;
		
    }, TMP_386.$$arity = 3);

    Opal.defs($scope.get('CqlsHypo'), '$seq', TMP_387 = function $$seq(min, max, length) {
      var self = this;

      
			var arr = [],
			hival = Math.pow(10, 17 - ~~(Math.log(((max > 0) ? max : -max)) * Math.LOG10E)),
			step = (max * hival - min * hival) / ((length - 1) * hival),
			current = min,
			cnt = 0;
			// current is assigned using a technique to compensate for IEEE error
			for (; current <= max; cnt++, current = (min * hival + step * hival * cnt) / hival)
				arr.push(current);
			return arr;
		
    }, TMP_387.$$arity = 3);
  })($scope.base);
})(Opal);

/* Generated by Opal 0.10.3 */
(function(Opal) {
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$exit']);
  return $scope.get('Kernel').$exit()
})(Opal);
